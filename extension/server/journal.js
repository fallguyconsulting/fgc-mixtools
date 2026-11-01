// Mix journal: a Markdown file in each song's folder that records what the
// person wants and what was done, so a new conversation can pick up where the
// last one stopped. The person can read it and add their own lines.

import { promises as fs } from "node:fs";
import path from "node:path";

export const JOURNAL_FILE = "Mix notes.md";
const ABOUT = "## About this song";
const LOG = "## Log";
const NOTHING_YET = "_Nothing yet._";

const pad = (n) => String(n).padStart(2, "0");
const stamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
const oneLine = (s) => String(s).replace(/\s*\n\s*/g, " ").trim();

const template = (song) => `# Mix notes: ${song}

Claude keeps these notes so the next conversation can pick up where the last one stopped. You can read them and add your own lines under Log.

${ABOUT}

${NOTHING_YET}

${LOG}

`;

export const journalPath = (songDir) => path.join(songDir, JOURNAL_FILE);

async function readText(songDir) {
  try {
    return await fs.readFile(journalPath(songDir), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

/** Split the file into its about text and its log lines. Tolerates hand edits. */
function parse(text) {
  const a = text.indexOf(ABOUT);
  const l = text.indexOf(LOG);
  const about = a >= 0 ? text.slice(a + ABOUT.length, l > a ? l : undefined).trim() : "";
  const log = l >= 0
    ? text.slice(l + LOG.length).split("\n").map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/^[-*]\s+/, ""))
    : [];
  return { about: about === NOTHING_YET ? "" : about, log };
}

/** Add one dated line to the log, creating the file if needed. */
export async function append(songDir, text) {
  let body = (await readText(songDir)) ?? template(path.basename(songDir));
  if (!body.includes(LOG)) body = `${body.replace(/\s*$/, "")}\n\n${LOG}\n\n`;
  if (!body.endsWith("\n")) body += "\n";
  await fs.writeFile(journalPath(songDir), `${body}- ${stamp()} · ${oneLine(text)}\n`);
}

/** Replace the "About this song" section. */
export async function setAbout(songDir, text) {
  let body = (await readText(songDir)) ?? template(path.basename(songDir));
  if (!body.includes(LOG)) body = `${body.replace(/\s*$/, "")}\n\n${LOG}\n\n`;
  const section = `${ABOUT}\n\n${String(text).trim() || NOTHING_YET}\n\n`;
  const a = body.indexOf(ABOUT);
  const l = body.indexOf(LOG);
  body = a >= 0 && a < l ? body.slice(0, a) + section + body.slice(l) : body.slice(0, l) + section + body.slice(l);
  await fs.writeFile(journalPath(songDir), body);
}

/** Read the about text and the last `limit` log lines. */
export async function read(songDir, limit = 30) {
  const text = await readText(songDir);
  if (text == null) return { file: journalPath(songDir), exists: false, about: "", log: [], total_entries: 0 };
  const { about, log } = parse(text);
  return { file: journalPath(songDir), exists: true, about, log: log.slice(-limit), total_entries: log.length };
}

/** The most recent log line, for listing songs. */
export async function lastEntry(songDir) {
  const text = await readText(songDir);
  if (text == null) return null;
  return parse(text).log.at(-1) ?? null;
}
