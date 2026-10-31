#!/usr/bin/env node
// Mixtools MCP server: lets Claude mix a song in Ardour for someone who is not
// an audio engineer. Speaks MCP over stdio with no dependencies.

import { spawn } from "node:child_process";
import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import * as ardour from "./ardour.js";
import { compare, encodeWavFloat, loadAudio, measure } from "./audio.js";
import { SPECTROGRAM_GRID_HZ, spectrogram } from "./spectrogram.js";

const VERSION = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8")).version;
const AUDIO_EXTS = new Set([".wav", ".aif", ".aiff", ".mp3", ".m4a", ".aac", ".flac", ".caf", ".ogg"]);

// ---------------------------------------------------------------------------
// Tool definitions

const range = {
  start: { type: "number", minimum: 0, description: "Start time in seconds. Default: beginning." },
  end: { type: "number", minimum: 0, description: "End time in seconds. Default: end of file." },
};

const TOOLS = [
  {
    name: "mixtools_status",
    description:
      "Check everything mixtools needs: Ardour installed, Ardour open, Ardour's MCP server reachable, the open song, and the workspace folders. Returns a list of problems, each with its fix. Call this first in every session.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "mixtools_setup",
    description:
      "Create the workspace folders (~/Music/Mixtools: Songs, References, Bounces) and turn on Ardour's MCP server in Ardour's settings. Turning the server on only works while Ardour is closed. Safe to run again.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "song_new",
    description:
      "Start a new song: create an Ardour session in ~/Music/Mixtools/Songs, open it in Ardour, and import audio files as tracks (one track per file). Ardour must be closed first. Takes up to a few minutes for long files.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Song name, used for the session folder." },
        files: { type: "array", items: { type: "string" }, description: "Absolute paths of audio files to import, one track each." },
        track_names: { type: "array", items: { type: "string" }, description: "Optional track names, matched to files by position." },
      },
      required: ["name", "files"],
      additionalProperties: false,
    },
  },
  {
    name: "song_open",
    description: "Open a song in Ardour. With no path, list the songs in ~/Music/Mixtools/Songs instead. Ardour must be closed or already showing that song.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Song folder or .ardour file." } },
      additionalProperties: false,
    },
  },
  {
    name: "ardour_tools",
    description:
      "List Ardour's own MCP tools (tracks, faders, pan, sends, plugins, transport, markers, regions, undo). With 'name', return that tool's full input schema. Use with ardour_call.",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Only tools whose name contains this text, for example 'plugin' or 'send'." },
        name: { type: "string", description: "Return the full schema of this one tool." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ardour_call",
    description:
      "Call one of Ardour's MCP tools by name, for example track_set_fader_db, track_set_pan, plugin_add, plugin_set_parameter, track_add_send, transport_play. Read its schema with ardour_tools first.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        arguments: { type: "object", description: "Arguments for the Ardour tool." },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "snapshot_save",
    description: "Save the current mixer settings (faders, pans, mutes, plugin settings) as a snapshot so they can be restored. Call before every change.",
    inputSchema: { type: "object", properties: { label: { type: "string" } }, required: ["label"], additionalProperties: false },
  },
  {
    name: "snapshot_list",
    description: "List this song's mixer snapshots.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "snapshot_restore",
    description: "Put the mixer back to a saved snapshot. Saves the current settings as a new snapshot first, so restoring can itself be undone.",
    inputSchema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"], additionalProperties: false },
  },
  {
    name: "bounce",
    description:
      "Render the song to a WAV file in ~/Music/Mixtools/Bounces. Saves the song first. With 'stems', also renders each named track alone (by soloing it).",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string", description: "Short label for the file name, for example 'before vocal eq'." },
        stems: { type: "array", items: { type: "string" }, description: "Track names to render alone." },
      },
      required: ["label"],
      additionalProperties: false,
    },
  },
  {
    name: "audio_measure",
    description:
      "Measure an audio file: integrated loudness (LUFS), loudness range, sample and true peak, RMS, crest factor, clipping, stereo correlation and width, mono compatibility, and the share of energy in seven frequency bands (sub, bass, low_mid, mid, high_mid, presence, brilliance).",
    inputSchema: { type: "object", properties: { path: { type: "string" }, ...range }, required: ["path"], additionalProperties: false },
  },
  {
    name: "audio_compare",
    description:
      "Measure two audio files and report B minus A, plus the largest differences in plain words. Band levels are each file's share of its own energy, so loudness differences do not hide tone differences. Use for before/after bounces or mix vs. reference.",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "string", description: "First file (before, or the reference)." },
        b: { type: "string", description: "Second file (after, or the mix)." },
        a_start: { type: "number", minimum: 0 },
        a_end: { type: "number", minimum: 0 },
        b_start: { type: "number", minimum: 0 },
        b_end: { type: "number", minimum: 0 },
      },
      required: ["a", "b"],
      additionalProperties: false,
    },
  },
  {
    name: "audio_spectrogram",
    description:
      "Draw a spectrogram of an audio file as an image: time left to right, frequency bottom (20 Hz) to top (20 kHz) on a log scale, brightness as energy. Faint lines mark 50, 100, 200, 500 Hz and 1, 2, 5, 10 kHz.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, ...range }, required: ["path"], additionalProperties: false },
  },
  {
    name: "audio_play",
    description: "Play an audio file through the Mac's speakers or headphones. Stops anything mixtools is already playing.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, ...range }, required: ["path"], additionalProperties: false },
  },
  {
    name: "audio_stop",
    description: "Stop playback started by audio_play.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "reference_list",
    description: "List the reference songs in ~/Music/Mixtools/References with their length and loudness.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

// ---------------------------------------------------------------------------
// Tool implementations

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function status() {
  const problems = [];
  const version = await ardour.appVersion();
  const running = await ardour.isRunning();
  let session = null, mcp = false, importTool = false;
  try {
    session = await ardour.sessionInfo();
    mcp = true;
    importTool = (await ardour.listTools()).some((t) => t.name === "session_import_audio");
  } catch {}
  const enabled = await ardour.mcpEnabledInConfig();
  const folders = {};
  for (const [k, p] of Object.entries({ songs: ardour.SONGS, references: ardour.REFERENCES, bounces: ardour.BOUNCES })) {
    folders[k] = { path: p, exists: await exists(p) };
  }

  if (!version) problems.push({ problem: "Ardour is not installed in /Applications.", fix: "Install the Ardour build that came with mixtools: open its disk image and drag Ardour9 into Applications." });
  if (version && enabled === null) problems.push({ problem: "Ardour has never been opened.", fix: "Ask the person to open Ardour once, click through its first-run window, then quit it. Then call mixtools_setup." });
  if (version && enabled === false && !mcp) problems.push({ problem: "Ardour's MCP server is off.", fix: running ? "Ask the person to quit Ardour, then call mixtools_setup." : "Call mixtools_setup." });
  if (running && !mcp && enabled) problems.push({ problem: "Ardour is open but its MCP server is not answering.", fix: "If Ardour is still starting or showing a window, ask the person to finish it. If no song is open, call song_open or song_new." });
  if (mcp && !importTool) problems.push({ problem: "This Ardour cannot import audio for mixtools.", fix: "Install the Ardour build that came with mixtools; the standard Ardour download lacks the import tool." });
  if (Object.values(folders).some((f) => !f.exists)) problems.push({ problem: "Workspace folders are missing.", fix: "Call mixtools_setup." });

  return {
    mixtools_version: VERSION,
    ardour: { installed: !!version, version, open: running, mcp_server_on_in_settings: enabled, mcp_connected: mcp, import_supported: importTool },
    song: session ? { name: session.sessionName, path: session.path, unsaved_changes: session.dirty, sample_rate: session.sampleRate } : null,
    workspace: folders,
    problems,
  };
}

async function setup() {
  const created = [];
  for (const p of [ardour.SONGS, ardour.REFERENCES, ardour.BOUNCES]) {
    if (!(await exists(p))) {
      await fs.mkdir(p, { recursive: true });
      created.push(p);
    }
  }
  const mcp = (await ardour.mcpEnabledInConfig()) ? { changed: false, reason: "already on" } : await ardour.enableMcpInConfig();
  return { created_folders: created, ardour_mcp_server: mcp, status: await status() };
}

let player = null;
let tempClip = null;

async function play(file, start, end) {
  await stopPlayback();
  let target = file;
  if (start != null || end != null) {
    const audio = await loadAudio(file, { start, end });
    tempClip = path.join(os.tmpdir(), `mixtools-clip-${process.pid}.wav`);
    await fs.writeFile(tempClip, encodeWavFloat(audio));
    target = tempClip;
  }
  player = spawn("/usr/bin/afplay", [target], { stdio: "ignore" });
  player.on("exit", () => (player = null));
  return { playing: path.basename(file), start: start ?? 0, end: end ?? null };
}

async function stopPlayback() {
  if (player) {
    player.kill();
    player = null;
  }
  return { stopped: true };
}

async function referenceList() {
  let names = [];
  try {
    names = await fs.readdir(ardour.REFERENCES);
  } catch {
    return { folder: ardour.REFERENCES, references: [], note: "The folder does not exist yet. Call mixtools_setup." };
  }
  const refs = [];
  for (const n of names.sort()) {
    if (!AUDIO_EXTS.has(path.extname(n).toLowerCase())) continue;
    const p = path.join(ardour.REFERENCES, n);
    try {
      const m = await measure(p);
      refs.push({ file: p, seconds: m.seconds, loudness_lufs: m.loudness_lufs });
    } catch (e) {
      refs.push({ file: p, error: e.message });
    }
  }
  return { folder: ardour.REFERENCES, references: refs };
}

async function ardourTools({ filter, name }) {
  const tools = await ardour.listTools();
  if (name) {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`Ardour has no tool named ${name}.`);
    return t;
  }
  const f = (filter || "").toLowerCase();
  return tools.filter((t) => !f || t.name.includes(f)).map((t) => ({ name: t.name, description: t.description }));
}

const HANDLERS = {
  mixtools_status: () => status(),
  mixtools_setup: () => setup(),
  song_new: (a) => ardour.newSong(a.name, a.files, a.track_names),
  song_open: async (a) => (a.path ? ardour.openSong(a.path) : { songs: await ardour.listSongs() }),
  ardour_tools: (a) => ardourTools(a),
  ardour_call: (a) => ardour.call(a.name, a.arguments ?? {}),
  snapshot_save: (a) => ardour.snapshotSave(a.label),
  snapshot_list: () => ardour.snapshotList(),
  snapshot_restore: (a) => ardour.snapshotRestore(a.id),
  bounce: (a) => ardour.bounce(a.label, a.stems ?? []),
  audio_measure: (a) => measure(a.path, a),
  audio_compare: (a) => compare(a.a, a.b, { start: a.a_start, end: a.a_end }, { start: a.b_start, end: a.b_end }),
  audio_spectrogram: async (a) => {
    const { png, seconds } = await spectrogram(a.path, a);
    return {
      content: [
        { type: "image", data: png.toString("base64"), mimeType: "image/png" },
        {
          type: "text",
          text: `Spectrogram of ${path.basename(a.path)}, ${seconds.toFixed(1)} s shown. Time runs left to right. Frequency runs from 20 Hz at the bottom to 20 kHz at the top on a log scale; faint lines mark ${SPECTROGRAM_GRID_HZ.join(", ")} Hz. Brighter means more energy (90 dB range).`,
        },
      ],
    };
  },
  audio_play: (a) => play(a.path, a.start, a.end),
  audio_stop: () => stopPlayback(),
  reference_list: () => referenceList(),
};

// ---------------------------------------------------------------------------
// MCP over stdio

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notification
  try {
    if (method === "initialize") {
      return send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "mixtools", version: VERSION },
        },
      });
    }
    if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
    if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    if (method === "tools/call") {
      const handler = HANDLERS[params?.name];
      if (!handler) return send({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${params?.name}` } });
      try {
        const out = await handler(params.arguments ?? {});
        const result = out?.content ? out : { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
        return send({ jsonrpc: "2.0", id, result });
      } catch (e) {
        return send({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: e.message }] } });
      }
    }
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (e) {
    send({ jsonrpc: "2.0", id, error: { code: -32603, message: e.message } });
  }
}

const pending = new Set();
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  const p = handle(msg).finally(() => pending.delete(p));
  pending.add(p);
});
rl.on("close", async () => {
  await Promise.allSettled([...pending]);
  await stopPlayback();
  if (tempClip) await fs.rm(tempClip, { force: true });
  process.exit(0);
});
