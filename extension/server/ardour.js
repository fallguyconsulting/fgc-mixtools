// Ardour: finding the app, turning on its MCP server, talking to it, and
// running its command-line session tools.

import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const APP = "/Applications/Ardour9.app";
export const ENDPOINT = "http://127.0.0.1:4820/mcp";
const CONFIG = path.join(os.homedir(), "Library/Preferences/Ardour9/config");
const MCP_PROTOCOL = "MCP HTTP Server (Experimental)";
const MCP_ENABLED = `<Protocol name="${MCP_PROTOCOL}" active="1" config="" port="4820"/>`;

export const WORKSPACE = path.join(os.homedir(), "Music/Mixtools");
export const SONGS = path.join(WORKSPACE, "Songs");
export const REFERENCES = path.join(WORKSPACE, "References");
export const BOUNCES = path.join(WORKSPACE, "Bounces");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// App

export async function appVersion() {
  try {
    // Ardour's Info.plist has no CFBundleShortVersionString (it spells it CFBundleShortVersions).
    const { stdout } = await run("/usr/bin/plutil", ["-extract", "CFBundleVersion", "raw", path.join(APP, "Contents/Info.plist")]);
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function isRunning() {
  try {
    await run("/usr/bin/pgrep", ["-f", `${APP}/Contents/MacOS/`]);
    return true;
  } catch {
    return false;
  }
}

/** Launch Ardour, optionally opening a session file. */
export function launch(sessionFile) {
  const args = ["-a", APP];
  if (sessionFile) args.push("--args", sessionFile);
  const child = spawn("/usr/bin/open", args, { stdio: "ignore", detached: true });
  child.unref();
}

/** Wait until Ardour's MCP server answers, optionally with a given session open. */
export async function waitForSession(expectedPath, timeoutMs = 120000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const info = await sessionInfo();
      if (!expectedPath || samePath(info.path, expectedPath)) return info;
    } catch {}
    await sleep(1000);
  }
  return null;
}

const samePath = (a, b) => a && b && path.resolve(a).replace(/\/$/, "") === path.resolve(b).replace(/\/$/, "");

// ---------------------------------------------------------------------------
// MCP server switch

/** Whether Ardour's global settings turn the MCP server on. null if Ardour has never run. */
export async function mcpEnabledInConfig() {
  let text;
  try {
    text = await fs.readFile(CONFIG, "utf8");
  } catch {
    return null;
  }
  const m = text.match(new RegExp(`<Protocol name="${escapeRe(MCP_PROTOCOL)}"[^>]*>`));
  return !!m && /active="1"/.test(m[0]);
}

/**
 * Turn the MCP server on in Ardour's global settings. Ardour rewrites this
 * file when it quits, so this only works while Ardour is closed.
 */
export async function enableMcpInConfig() {
  if (await isRunning()) {
    return { changed: false, reason: "Ardour is open. It overwrites its settings when it quits, so quit Ardour first." };
  }
  let text;
  try {
    text = await fs.readFile(CONFIG, "utf8");
  } catch {
    return { changed: false, reason: "Ardour has not been opened yet, so it has no settings file. Open Ardour once, finish its first-run window, and quit it." };
  }
  const re = new RegExp(`<Protocol name="${escapeRe(MCP_PROTOCOL)}"[^>]*/>`);
  let next;
  if (re.test(text)) {
    next = text.replace(re, MCP_ENABLED);
  } else if (text.includes("</ControlProtocols>")) {
    next = text.replace("</ControlProtocols>", `  ${MCP_ENABLED}\n  </ControlProtocols>`);
  } else {
    return { changed: false, reason: "Ardour's settings file has no ControlProtocols section to edit." };
  }
  if (next === text) return { changed: false, reason: "already on" };
  await fs.copyFile(CONFIG, `${CONFIG}.mixtools-backup`);
  await fs.writeFile(CONFIG, next);
  return { changed: true };
}

/** Turn the MCP server on inside one session file, so it starts with that session. */
async function enableMcpInSession(sessionFile) {
  const text = await fs.readFile(sessionFile, "utf8");
  const re = new RegExp(`<Protocol name="${escapeRe(MCP_PROTOCOL)}"[^>]*/>`);
  const next = re.test(text) ? text.replace(re, MCP_ENABLED) : text.replace("</ControlProtocols>", `  ${MCP_ENABLED}\n  </ControlProtocols>`);
  await fs.writeFile(sessionFile, next);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---------------------------------------------------------------------------
// MCP client

let nextId = 1;

async function rpc(method, params, timeoutMs = 60000) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Ardour answered HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(body.error.message || JSON.stringify(body.error));
  return body.result;
}

export async function listTools() {
  return (await rpc("tools/list", {}, 10000)).tools;
}

/** Call one of Ardour's MCP tools and return its structured result. */
export async function call(name, args = {}, timeoutMs = 60000) {
  const result = await rpc("tools/call", { name, arguments: args }, timeoutMs);
  if (result.isError) {
    throw new Error(result.content?.map((c) => c.text).join(" ") || `Ardour tool ${name} failed`);
  }
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content?.map((c) => c.text).join("") ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

export const sessionInfo = () => call("session_get_info", {}, 5000);

export async function tracks() {
  const r = await call("tracks_list");
  return (r.tracks ?? []).filter((t) => t.type !== "bus" || t.name !== "Master");
}

export async function findTrack(nameOrId) {
  const all = await tracks();
  const lower = String(nameOrId).toLowerCase();
  const t = all.find((x) => x.id === String(nameOrId)) || all.find((x) => x.name.toLowerCase() === lower);
  if (!t) throw new Error(`No track named "${nameOrId}". Tracks: ${all.map((x) => x.name).join(", ")}`);
  return t;
}

// ---------------------------------------------------------------------------
// Songs (Ardour sessions)

const safeName = (s) => s.replace(/[^\w .-]+/g, "").trim().replace(/\s+/g, " ") || "Song";

async function sessionTool(tool, args) {
  const bin = path.join(APP, "Contents/MacOS", tool);
  return run(bin, args, { maxBuffer: 16 * 1024 * 1024, timeout: 30 * 60 * 1000 });
}

/** Create a new session for a song, open it in Ardour, and import audio files. */
export async function newSong(name, files, trackNames) {
  if (await isRunning()) {
    let info = null;
    try {
      info = await sessionInfo();
    } catch {}
    throw new Error(
      `Ardour is already open${info ? ` with "${info.sessionName}"` : ""}. Ask the person to save and quit Ardour (Session menu, then Quit), then try again.`,
    );
  }
  const song = safeName(name);
  const dir = path.join(SONGS, song);
  try {
    await fs.access(dir);
    throw new Error(`A song named "${song}" already exists at ${dir}. Pick another name or open that one.`);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  for (const f of files) {
    if (!path.isAbsolute(f)) throw new Error(`Not an absolute path: ${f}`);
    await fs.access(f);
  }
  await fs.mkdir(SONGS, { recursive: true });
  await sessionTool("ardour9-new_session", [dir, song]);
  const sessionFile = path.join(dir, `${song}.ardour`);
  await enableMcpInSession(sessionFile);

  launch(sessionFile);
  const info = await waitForSession(dir);
  if (!info) {
    throw new Error(
      "Ardour did not finish opening the song within two minutes. If Ardour is showing a window (for example audio setup), ask the person to click Start or OK, then call song_open.",
    );
  }
  const imported = files.length
    ? await call("session_import_audio", { paths: files, ...(trackNames?.length ? { trackNames } : {}) }, 30 * 60 * 1000)
    : { imported: [] };
  await call("session_save");
  return { song, path: dir, imported: imported.imported };
}

/** List songs in the workspace. */
export async function listSongs() {
  let entries = [];
  try {
    entries = await fs.readdir(SONGS, { withFileTypes: true });
  } catch {}
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const file = path.join(SONGS, e.name, `${e.name}.ardour`);
    try {
      const st = await fs.stat(file);
      out.push({ song: e.name, path: path.join(SONGS, e.name), modified: st.mtime.toISOString() });
    } catch {}
  }
  return out.sort((a, b) => b.modified.localeCompare(a.modified));
}

/** Open an existing session in Ardour. */
export async function openSong(sessionDirOrFile) {
  let file = sessionDirOrFile;
  if (!file.endsWith(".ardour")) {
    const names = (await fs.readdir(file)).filter((n) => n.endsWith(".ardour"));
    const base = path.basename(file);
    file = path.join(file, names.includes(`${base}.ardour`) ? `${base}.ardour` : names[0] ?? "");
  }
  await fs.access(file);
  const dir = path.dirname(file);
  if (await isRunning()) {
    const info = await sessionInfo().catch(() => null);
    if (info && samePath(info.path, dir)) return info;
    throw new Error("Ardour already has another song open. Ask the person to save and quit Ardour, then try again.");
  }
  await enableMcpInSession(file);
  launch(file);
  const info = await waitForSession(dir);
  if (!info) throw new Error("Ardour did not finish opening the song within two minutes. If Ardour is showing a window, ask the person to click Start or OK, then try again.");
  return info;
}

// ---------------------------------------------------------------------------
// Bounce

async function nextBouncePath(song, label) {
  const dir = path.join(BOUNCES, safeName(song));
  await fs.mkdir(dir, { recursive: true });
  const nums = (await fs.readdir(dir)).map((f) => parseInt(f, 10)).filter(Number.isFinite);
  const n = String((nums.length ? Math.max(...nums) : 0) + 1).padStart(3, "0");
  const slug = safeName(label || "mix").replace(/ /g, "-").toLowerCase();
  return { dir, base: `${n}-${slug}` };
}

async function exportSession(info, out) {
  // ardour9-export renders the saved session from disk, so save first.
  await call("session_save");
  await sessionTool("ardour9-export", ["-b", "float", "-o", out, info.path, info.snapshotName || info.sessionName]);
  await fs.access(out);
  return out;
}

/**
 * Set a track's solo and wait until Ardour reports it. Ardour applies solo
 * changes after the call returns, and a save made before then records the old
 * state.
 */
async function setSolo(id, value) {
  await call("track_set_solo", { id, value });
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    if ((await call("track_get_info", { id })).solo === value) return;
    await sleep(50);
  }
  throw new Error(`Ardour did not ${value ? "solo" : "unsolo"} track ${id} within 5 seconds.`);
}

/**
 * Bounce the full mix, and optionally one stem per named track. Stems are made
 * by soloing each track in turn; every solo is restored afterwards.
 */
export async function bounce(label, stemTracks = []) {
  const info = await sessionInfo();
  const { dir, base } = await nextBouncePath(info.sessionName, label);
  const mix = await exportSession(info, path.join(dir, `${base}.wav`));
  const stems = [];
  if (stemTracks.length) {
    const all = await tracks();
    const targets = await Promise.all(stemTracks.map(findTrack));
    // tracks_list leaves out solo state, so read each track.
    const soloed = [];
    for (const t of all) {
      if ((await call("track_get_info", { id: t.id })).solo) soloed.push(t.id);
    }
    try {
      for (const id of soloed) await setSolo(id, false);
      for (const t of targets) {
        await setSolo(t.id, true);
        try {
          const file = path.join(dir, `${base}-stem-${safeName(t.name).replace(/ /g, "-").toLowerCase()}.wav`);
          stems.push({ track: t.name, file: await exportSession(info, file) });
        } finally {
          await setSolo(t.id, false);
        }
      }
    } finally {
      for (const id of soloed) await setSolo(id, true);
      await call("session_save");
    }
  }
  return { mix, stems };
}

// ---------------------------------------------------------------------------
// Snapshots (Ardour mixer scenes, labelled in a file beside the session)

const snapshotFile = (info) => path.join(info.path, "mixtools-snapshots.json");

async function readSnapshots(info) {
  try {
    return JSON.parse(await fs.readFile(snapshotFile(info), "utf8"));
  } catch {
    return [];
  }
}

export async function snapshotSave(label) {
  const info = await sessionInfo();
  const list = await readSnapshots(info);
  const index = list.length ? Math.max(...list.map((s) => s.index)) + 1 : 0;
  if (index > 1024) throw new Error("This song has used all 1025 mixer snapshot slots.");
  await call("session_store_mixer_scene", { index });
  const snap = { id: index + 1, index, label: label || `snapshot ${index + 1}`, time: new Date().toISOString() };
  list.push(snap);
  await fs.writeFile(snapshotFile(info), JSON.stringify(list, null, 2));
  await call("session_save");
  return snap;
}

export async function snapshotList() {
  return readSnapshots(await sessionInfo());
}

export async function snapshotRestore(id) {
  const info = await sessionInfo();
  const list = await readSnapshots(info);
  const snap = list.find((s) => s.id === Number(id));
  if (!snap) throw new Error(`No snapshot ${id}. Snapshots: ${list.map((s) => `${s.id} (${s.label})`).join(", ") || "none"}`);
  const safety = await snapshotSave(`before restoring ${snap.id} (${snap.label})`);
  await call("session_recall_mixer_scene", { index: snap.index });
  await call("session_save");
  return { restored: snap, safety_snapshot: safety };
}
