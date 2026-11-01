// Song archive: one zip with everything needed to reopen a song or hand it on:
// the Ardour session with its audio, masters, versions, stems, the final mix
// bounce, and the mix notes.

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import * as ardour from "./ardour.js";
import { JOURNAL_FILE } from "./journal.js";

const run = promisify(execFile);

export const ARCHIVES = path.join(ardour.WORKSPACE, "Archives");
export const BOUNCE_CHOICES = ["final", "all", "none"];

// Ardour rebuilds these, or they hold nothing the song needs.
const SKIP_IN_SESSION = new Set(["peaks", "dead", "analysis", "plugins.cache"]);
const SKIP_FILE = /\.(bak|pending|tmp)$/i;

const pad = (n) => String(n).padStart(2, "0");
const today = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Copy a folder. APFS clones make this cheap; the zip holds the real bytes. */
async function cloneDir(from, to) {
  await fs.mkdir(path.dirname(to), { recursive: true });
  await run("/bin/cp", ["-cR", from, to]);
}

async function sizeOf(p) {
  const st = await fs.lstat(p);
  if (!st.isDirectory()) return { bytes: st.size, files: 1 };
  let bytes = 0, files = 0;
  for (const name of await fs.readdir(p)) {
    const s = await sizeOf(path.join(p, name));
    bytes += s.bytes;
    files += s.files;
  }
  return { bytes, files };
}

async function prune(dir) {
  for (const name of await fs.readdir(dir)) {
    const p = path.join(dir, name);
    const st = await fs.lstat(p);
    if (st.isDirectory() && SKIP_IN_SESSION.has(name)) await fs.rm(p, { recursive: true, force: true });
    else if (st.isFile() && SKIP_FILE.test(name)) await fs.rm(p, { force: true });
  }
}

/** Audio the session uses from outside its own folder. The archive cannot bring those along. */
async function outsideAudio(sessionDir, song) {
  let xml;
  try {
    xml = await fs.readFile(path.join(sessionDir, `${song}.ardour`), "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const m of xml.matchAll(/<Source\b[^>]*\bname="([^"]+)"/g)) {
    if (m[1].startsWith("/") && !m[1].startsWith(sessionDir)) out.push(m[1]);
  }
  return [...new Set(out)];
}

/** The bounces to include: the latest "final mix" bounce and its stems, or all, or none. */
async function pickBounces(bounceDir, choice) {
  if (choice === "none" || !(await exists(bounceDir))) return [];
  const names = (await fs.readdir(bounceDir)).filter((n) => n.endsWith(".wav")).sort();
  if (choice === "all") return names;
  const mixes = names.filter((n) => !n.includes("-stem-"));
  const finals = mixes.filter((n) => /final-mix/.test(n));
  const pick = finals.at(-1) ?? mixes.at(-1);
  if (!pick) return [];
  const base = pick.replace(/\.wav$/, "");
  return names.filter((n) => n === pick || n.startsWith(`${base}-stem-`));
}

const readMe = (song, { bounces, masters }) => `${song}: song archive made by mixtools on ${today()}

${song}/
  The Ardour session, with all of its recordings. To work on the song again,
  move this folder into ~/Music/Mixtools/Songs and open "${song}.ardour" with
  the mixtools build of Ardour (or ask Claude to open the song).
${masters ? `
Masters/
  The release masters, any alternate versions (instrumental, clean, and so on),
  and stems. These are the files to upload or send.
` : ""}${bounces ? `
Bounces/
  ${bounces === "all" ? "Every bounce made while mixing." : "The final mix before mastering, and its stems if any."}
` : ""}
${JOURNAL_FILE}
  What the artist wanted and what was changed, in order.
`;

/**
 * Zip a song. `songDir` is the song's session folder. Saves the song first
 * when Ardour has it open.
 */
export async function archiveSong(songDir, { bounces = "final" } = {}) {
  if (!BOUNCE_CHOICES.includes(bounces)) throw new Error(`bounces must be one of: ${BOUNCE_CHOICES.join(", ")}.`);
  const song = path.basename(songDir);
  let saved = false;
  try {
    const info = await ardour.sessionInfo();
    if (info.path.replace(/\/$/, "") === songDir) {
      await ardour.call("session_save");
      saved = true;
    }
  } catch {}

  const root = `${song} (archive ${today()})`;
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), "mixtools-archive-"));
  const top = path.join(stage, root);
  try {
    await cloneDir(songDir, path.join(top, song));
    await prune(path.join(top, song));
    const notes = path.join(songDir, JOURNAL_FILE);
    if (await exists(notes)) await fs.copyFile(notes, path.join(top, JOURNAL_FILE));

    const mastersDir = path.join(ardour.MASTERS, song);
    const hasMasters = await exists(mastersDir);
    if (hasMasters) await cloneDir(mastersDir, path.join(top, "Masters"));

    const bounceDir = path.join(ardour.BOUNCES, song);
    const chosen = await pickBounces(bounceDir, bounces);
    for (const n of chosen) {
      await fs.mkdir(path.join(top, "Bounces"), { recursive: true });
      await run("/bin/cp", ["-c", path.join(bounceDir, n), path.join(top, "Bounces", n)]);
    }
    await fs.writeFile(path.join(top, "Read me.txt"), readMe(song, { bounces: chosen.length ? bounces : null, masters: hasMasters }));

    await fs.mkdir(ARCHIVES, { recursive: true });
    let zip = path.join(ARCHIVES, `${root}.zip`);
    for (let n = 2; await exists(zip); n++) zip = path.join(ARCHIVES, `${root} ${n}.zip`);
    const staged = await sizeOf(top);
    await run("/usr/bin/ditto", ["-c", "-k", "--norsrc", "--keepParent", top, zip], { maxBuffer: 1 << 24 });

    // Check the zip: it reads back without errors and lists every staged file.
    await run("/usr/bin/unzip", ["-tq", zip], { maxBuffer: 1 << 26 });
    const { stdout } = await run("/usr/bin/zipinfo", ["-1", zip], { maxBuffer: 1 << 26 });
    const listed = stdout.split("\n").filter((l) => l && !l.endsWith("/")).length;
    if (listed !== staged.files) throw new Error(`The archive lists ${listed} files but ${staged.files} were packed. Try again.`);
    if (!stdout.includes(`${root}/${song}/${song}.ardour`)) throw new Error(`The archive is missing ${song}.ardour. Try again.`);

    const warnings = [];
    const outside = await outsideAudio(songDir, song);
    if (outside.length) warnings.push(`The session uses ${outside.length} audio file${outside.length === 1 ? "" : "s"} from outside its folder, which the archive does not include: ${outside.join(", ")}.`);
    if (!hasMasters) warnings.push("This song has no masters yet.");

    return {
      archive: zip,
      size_mb: Math.round(((await fs.stat(zip)).size / 1e6) * 10) / 10,
      files: staged.files,
      contents: {
        session: `${song}/`,
        masters: hasMasters ? (await fs.readdir(mastersDir)).filter((n) => !n.startsWith(".")) : [],
        bounces: chosen,
        mix_notes: await exists(notes),
      },
      saved_song_first: saved,
      warnings,
    };
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}
