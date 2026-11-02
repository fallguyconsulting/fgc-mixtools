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
export const MASTERS = path.join(WORKSPACE, "Masters");

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
// Lua scripts and MIDI parts

/** Ardour tools that the mixtools build of Ardour 9.8.2 adds. */
export const MIDI_IMPORT_TOOL = "session_import_midi";
export const LUA_TOOL = "session_run_lua";

/**
 * Run a Lua script in Ardour. Returns Ardour's report, { ok, output,
 * outputCut, result, error }, whether or not the script failed.
 */
export async function runLua(script, timeoutSeconds = 10) {
  const result = await rpc("tools/call", { name: LUA_TOOL, arguments: { script, timeoutSeconds } }, (timeoutSeconds + 15) * 1000);
  const r = result.structuredContent;
  if (!r) throw new Error(result.content?.map((c) => c.text).join(" ") || "Ardour did not run the script.");
  const { session, ...rest } = r;
  return rest;
}

/**
 * Save the song, then save a copy of Ardour's whole session state (tracks,
 * regions, plugins, mixer) as an Ardour snapshot that stays beside the song.
 * Opening that snapshot file in Ardour brings everything back.
 */
export async function fullBackup() {
  await call("session_save");
  const info = await sessionInfo();
  const stamp = localStamp(true);
  let name = `mixtools backup ${stamp}`;
  for (let n = 2; await exists(path.join(info.path, `${name}.ardour`)); n++) name = `mixtools backup ${stamp} ${n}`;
  await call("session_save", { snapshotName: name, switchToSnapshot: false });
  return { snapshot: name, file: path.join(info.path, `${name}.ardour`) };
}

/** Local date and time for file names, such as 2026-11-02 03.23.17 (with .107 milliseconds). */
function localStamp(ms = false) {
  const d = new Date();
  const two = (n) => String(n).padStart(2, "0");
  const t = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}.${two(d.getMinutes())}.${two(d.getSeconds())}`;
  return ms ? `${t}.${String(d.getMilliseconds()).padStart(3, "0")}` : t;
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Import a MIDI file onto a new MIDI track. */
export async function importMidi(file, { trackName, instrument, bar, beat } = {}) {
  const args = { paths: [file], ...(trackName ? { trackNames: [trackName] } : {}), ...(instrument ? { instrument } : {}), ...(bar ? { bar } : {}), ...(beat ? { beat } : {}) };
  const r = await call(MIDI_IMPORT_TOOL, args, 120000);
  return r.imported ?? [];
}

/** Remove a track from the song. Ardour cannot undo this. */
export async function removeTrack(id) {
  const r = await runLua(
    `local r = Session:route_by_id (PBD.ID (${JSON.stringify(String(id))}))
assert (r and not r:isnil (), "no track with id ${String(id).replace(/[^0-9]/g, "")}")
local rl = ARDOUR.RouteListPtr ()
rl:push_back (r)
Session:remove_routes (rl)
return "removed"`,
  );
  if (!r.ok) throw new Error(`Could not remove the track: ${r.error}`);
}

export const renameTrack = (id, newName) => call("track_rename", { id: String(id), newName });

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

/**
 * Put a song back to a full backup made by fullBackup: with Ardour closed,
 * keep a copy of the song's current state, copy the backup over the song's
 * main session file, and open the song.
 */
export async function restoreBackup(backupFile) {
  if (!backupFile.endsWith(".ardour") || !path.isAbsolute(backupFile)) throw new Error("Give the backup's .ardour file, as an absolute path.");
  await fs.access(backupFile);
  if (await isRunning()) throw new Error("Ardour is open. Ask the person to quit Ardour without saving, then try again.");
  const dir = path.dirname(backupFile);
  // A snapshot file names its session; the session's main file is <name>.ardour.
  const name = (await fs.readFile(backupFile, "utf8")).match(/<Session\b[^>]*\bname="([^"]+)"/)?.[1];
  if (!name) throw new Error(`${path.basename(backupFile)} is not an Ardour session file.`);
  const main = path.join(dir, `${name.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&apos;/g, "'")}.ardour`);
  await fs.access(main);
  if (path.resolve(main) === path.resolve(backupFile)) throw new Error("That is the song's own file, not a backup.");
  const kept = path.join(dir, `${path.basename(main, ".ardour")} before restore ${localStamp()}.ardour`);
  await fs.copyFile(main, kept);
  await fs.copyFile(backupFile, main);
  const info = await openSong(main);
  return { restored_from: backupFile, previous_state_kept_as: kept, song: info.sessionName };
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
// Variants: the mix with some tracks muted, only some tracks playing, or
// stretches of some tracks silenced. Everything is put back afterwards.

async function setMute(id, value) {
  await call("track_set_mute", { id, value });
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    if (!!(await call("track_get_info", { id })).mute === value) return;
    await sleep(50);
  }
  throw new Error(`Ardour did not ${value ? "mute" : "unmute"} track ${id} within 5 seconds.`);
}

const regionLayout = async (id) =>
  (await call("track_get_regions", { id })).regions.map((r) => `${r.regionId}:${r.startSample}-${r.endSample}`).join(",");

/**
 * Silence [start, end) samples on one track: split the regions there and set
 * the piece's gain to zero. Returns the number of undoable steps taken.
 */
async function silenceStretch(id, start, end) {
  let steps = 0;
  const regions = async () => (await call("track_get_regions", { id })).regions;
  for (const r of await regions()) {
    if (r.endSample <= start || r.startSample >= end) continue;
    if (r.startSample < start) {
      await call("region_split", { regionId: r.regionId, sample: start });
      steps++;
    }
  }
  for (const r of await regions()) {
    if (r.startSample < start || r.startSample >= end) continue;
    if (r.endSample > end) {
      await call("region_split", { regionId: r.regionId, sample: end });
      steps++;
    }
  }
  for (const r of await regions()) {
    if (r.startSample >= start && r.endSample <= end) {
      await call("region_set_gain_linear", { regionId: r.regionId, linear: 0 });
      steps++;
    }
  }
  return steps;
}

/**
 * Render the mix as a variant. `mute` lists track ids to mute; `only` lists
 * track ids to solo; `silence` lists { id, start, end } sample stretches to
 * silence. Mutes and solos go back to how they were, and region edits are
 * undone, even if rendering fails.
 */
export async function renderVariant(label, { mute = [], only = null, silence = [] } = {}) {
  const info = await sessionInfo();
  const { dir, base } = await nextBouncePath(info.sessionName, label);
  const all = await tracks();
  const state = [];
  for (const t of all) {
    const i = await call("track_get_info", { id: t.id });
    state.push({ id: t.id, mute: !!i.mute, solo: !!i.solo });
  }
  const layouts = {};
  for (const s of silence) layouts[s.id] ??= await regionLayout(s.id);

  let steps = 0;
  try {
    for (const s of silence) steps += await silenceStretch(s.id, s.start, s.end);
    for (const id of mute) await setMute(id, true);
    if (only) {
      for (const s of state) if (s.solo && !only.includes(s.id)) await setSolo(s.id, false);
      for (const id of only) await setSolo(id, true);
    }
    return await exportSession(info, path.join(dir, `${base}.wav`));
  } finally {
    for (const s of state) {
      const now = await call("track_get_info", { id: s.id });
      if (!!now.solo !== s.solo) await setSolo(s.id, s.solo);
      if (!!now.mute !== s.mute) await setMute(s.id, s.mute);
    }
    if (steps) {
      await call("session_undo", { count: steps });
      for (const [id, before] of Object.entries(layouts)) {
        if ((await regionLayout(id)) !== before) {
          throw new Error(`Undoing the silenced stretches did not put track ${id}'s regions back as they were. Check it in Ardour's Editor window, and use Edit, then Undo, if needed.`);
        }
      }
    }
    await call("session_save");
  }
}

// ---------------------------------------------------------------------------
// Markers

/** Where the session range starts. A bounce's time 0 is this sample. */
export async function sessionStartSample() {
  const { markers = [] } = await call("markers_list");
  const start = markers.find((m) => m.source === "session_range_boundary" && m.boundary === "start");
  return start?.startSample ?? 0;
}

/**
 * Move the playhead and wait until Ardour reports it there. A busy Ardour can
 * drop a locate request, so ask again each second.
 */
async function locate(sample, tries = 5) {
  for (let k = 0; k < tries; k++) {
    await call("transport_locate_sample", { sample });
    const until = Date.now() + 1000;
    while (Date.now() < until) {
      const st = await call("transport_get_state");
      if (!st.rolling && Math.abs(st.sample - sample) <= 1) return;
      await sleep(50);
    }
  }
  throw new Error(`Ardour's playhead did not move to sample ${sample}. If Ardour is showing a window, ask the person to close it, then try again.`);
}

/**
 * Stop playback and return where the playhead settles. Ardour keeps moving
 * for a moment after a stop, so wait for two equal readings.
 */
export async function stopAndReadPlayhead(timeoutMs = 3000) {
  if ((await call("transport_get_state")).rolling) await call("transport_stop");
  const until = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < until) {
    const st = await call("transport_get_state");
    if (!st.rolling && last != null && st.sample === last) return st.sample;
    last = st.rolling ? null : st.sample;
    await sleep(100);
  }
  throw new Error("Ardour's playhead did not settle after stopping.");
}

/**
 * Add a marker at an exact sample. Ardour adds markers only at the playhead or
 * a bar and beat, so stop, move the playhead there, and add it. The playhead
 * stays at the marker, so pressing play in Ardour starts there.
 */
export async function addMarkerAt(sample, name) {
  if ((await call("transport_get_state")).rolling) await call("transport_stop");
  await locate(sample);
  await call("markers_add", { name });
  const { markers = [] } = await call("markers_list");
  const mine = markers
    .filter((m) => m.isMark && m.name === name)
    .sort((x, y) => Math.abs(x.startSample - sample) - Math.abs(y.startSample - sample))[0];
  if (!mine) throw new Error(`Ardour did not add the marker "${name}".`);
  // After playback stops, Ardour adds markers at its audible position, a few
  // samples from the playhead. Anything within about a millisecond is exact
  // enough to hear.
  if (Math.abs(mine.startSample - sample) > 64) {
    throw new Error(`Ardour put the marker "${name}" at sample ${mine.startSample}, not ${sample}.`);
  }
  return { location_id: mine.locationId, sample: mine.startSample, bar_beat: mine.bbt?.text ?? null };
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
