// Notes for the mixtools team: problems, struggles, and ideas Claude notices
// while working with the person, and reports that bundle them for sending.
// The person sends a report file by hand (Messages, email, AirDrop).

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import * as ardour from "./ardour.js";

const run = promisify(execFile);

export const REPORTS = path.join(ardour.WORKSPACE, "Reports");
export const NOTES_FILE = path.join(REPORTS, "Notes for the mixtools team.md");
const STATE_FILE = path.join(REPORTS, ".reported.json");
export const KINDS = ["problem", "struggle", "idea"];
export const RESULTS = ["pass", "fixed", "fail", "skipped"];

const pad = (n) => String(n).padStart(2, "0");
const stamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fileStamp = (d) => `${stamp(d).replace(":", "-")}-${pad(d.getSeconds())}`;
const oneLine = (s) => String(s ?? "").replace(/\s*\n\s*/g, " ").trim();

const HEADER = `# Notes for the mixtools team

Claude adds a line here when something in mixtools breaks, when you get stuck, or when it sees an idea that could help. A report bundles these notes so you can send them to the mixtools team.

`;

async function readNotes() {
  try {
    const text = await fs.readFile(NOTES_FILE, "utf8");
    return text.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}

async function reportedCount() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, "utf8")).reported_count ?? 0;
  } catch {
    return 0;
  }
}

/** How many notes no report has included yet. */
export async function unsentCount() {
  const notes = await readNotes();
  return Math.max(0, notes.length - Math.min(await reportedCount(), notes.length));
}

/** Add one dated note. */
export async function addNote({ kind, note, quote, song }, version) {
  if (!KINDS.includes(kind)) throw new Error(`kind must be one of: ${KINDS.join(", ")}.`);
  const text = oneLine(note);
  if (!text) throw new Error("Give the note.");
  await fs.mkdir(REPORTS, { recursive: true });
  let body;
  try {
    body = await fs.readFile(NOTES_FILE, "utf8");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    body = HEADER;
    // A new notes file starts the count of reported notes over.
    await fs.rm(STATE_FILE, { force: true });
  }
  if (!body.endsWith("\n")) body += "\n";
  const parts = [stamp(), kind, `mixtools ${version}`, ...(song ? [`song "${oneLine(song)}"`] : []), text];
  if (quote) parts.push(`They said: "${oneLine(quote)}"`);
  await fs.writeFile(NOTES_FILE, `${body}- ${parts.join(" · ")}\n`);
  return { file: NOTES_FILE, unsent_notes: await unsentCount() };
}

async function macosVersion() {
  try {
    return (await run("/usr/bin/sw_vers", ["-productVersion"])).stdout.trim();
  } catch {
    return null;
  }
}

function selftestTable(results) {
  const rows = results.map((r) => `| ${oneLine(r.step).replace(/\|/g, "/")} | ${r.result} | ${oneLine(r.detail).replace(/\|/g, "/")} |`);
  return ["| Step | Result | Detail |", "| --- | --- | --- |", ...rows].join("\n");
}

/**
 * Write a report with every note no earlier report included, plus versions,
 * status, and optional self-test results. Marks those notes as reported.
 */
export async function makeReport({ summary, selftest, show_in_finder }, { version, status }) {
  const notes = await readNotes();
  const from = Math.min(await reportedCount(), notes.length);
  const fresh = notes.slice(from);
  if (!fresh.length && !selftest?.length && !oneLine(summary)) {
    throw new Error("Nothing to report: no new notes, no self-test results, and no summary.");
  }
  for (const r of selftest ?? []) if (!RESULTS.includes(r.result)) throw new Error(`Each self-test result must be one of: ${RESULTS.join(", ")}.`);

  const now = new Date();
  let name = `Mixtools report ${fileStamp(now)}.md`;
  for (let n = 2; await fs.access(path.join(REPORTS, name)).then(() => true, () => false); n++) name = `Mixtools report ${fileStamp(now)} ${n}.md`;
  const file = path.join(REPORTS, name);
  const passed = (selftest ?? []).filter((r) => r.result === "pass" || r.result === "fixed").length;
  const lines = [
    `# Mixtools report, ${stamp(now)}`,
    "",
    "Please send this file to the mixtools team.",
    "",
    "## Summary",
    "",
    oneLine(summary) || "_No summary._",
    "",
    "## This Mac",
    "",
    `- mixtools ${version}`,
    `- Ardour ${status.ardour?.version ?? "not installed"}`,
    `- macOS ${(await macosVersion()) ?? "unknown"}`,
    `- ${os.cpus()[0]?.model ?? "unknown processor"}`,
    "",
  ];
  if (selftest?.length) {
    const count = (k) => selftest.filter((r) => r.result === k).length;
    lines.push(`## Self-test: ${passed} of ${selftest.length} steps passed (${count("fail")} failed, ${count("skipped")} skipped)`, "", selftestTable(selftest), "");
  }
  lines.push("## Notes", "", ...(fresh.length ? fresh.map((n) => `- ${n}`) : ["_No new notes._"]), "");
  lines.push("## Status", "", "```json", JSON.stringify({ ...status, workspace: undefined }, null, 2), "```", "");

  await fs.mkdir(REPORTS, { recursive: true });
  await fs.writeFile(file, lines.join("\n"));
  await fs.writeFile(STATE_FILE, JSON.stringify({ reported_count: notes.length, last_report: name }, null, 2));
  if (show_in_finder) {
    try {
      await run("/usr/bin/open", ["-R", file]);
    } catch {}
  }
  return {
    report: file,
    notes_included: fresh.length,
    selftest_steps: selftest?.length ?? 0,
    shown_in_finder: !!show_in_finder,
    how_to_send: "Drag the report file from the Finder window into a message or email to the mixtools team.",
  };
}
