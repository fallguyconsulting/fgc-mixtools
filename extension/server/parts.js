// Instrument parts: Claude writes a part as a plain-text note list, and this
// module turns it into a Standard MIDI File that Ardour imports onto a MIDI
// track. The note list stays beside the song so the part can be revised.

import { promises as fs } from "node:fs";
import path from "node:path";

export const PARTS_DIR = "mixtools-parts";

const PPQ = 960;
const RAMP_STEP = 1 / 32; // beats between points of a smooth change
const MAX_TEXT = 256 * 1024;

export const FORMAT = `One command per line. Times are in beats (quarter notes) from the start of the part and may be fractions such as 2.75. "#" after a space starts a comment.
  program <0-127>                         General MIDI sound, for General MIDI Synth (0 piano, 33 fingered bass, 40 violin, 68 oboe, 71 clarinet, 73 flute)
  note <pitch> <start> <length> <velocity 1-127>
  cc <number> <beat> <value 0-127>        set a controller (11 expression = loudness within notes, 1 mod wheel, 64 sustain pedal)
  cc <number> <beat> <value> -> <beat> <value>   move a controller smoothly
  bend <beat> <semitones>                 pitch bend, 0 = in tune
  bend <beat> <semitones> -> <beat> <semitones>  slide the bend smoothly
  bendrange <semitones>                   pitch-bend range, default 2
A pitch is a note name with octave (C4 = middle C = 60, F#5, Bb3) or a MIDI number. Write sounding pitch. The part follows the song's tempo, so there is no tempo command: write rubato into the note starts and lengths.`;

class PartError extends Error {}

function check(v, lo, hi, what, line) {
  if (!Number.isFinite(v) || v < lo || v > hi) throw new PartError(`line ${line}: ${what} ${v} is outside ${lo}-${hi}`);
  return v;
}

function num(s, what, line) {
  const v = Number(s);
  if (s === undefined || !Number.isFinite(v)) throw new PartError(`line ${line}: ${what} "${s ?? ""}" is not a number`);
  return v;
}

function pitch(s, line) {
  if (/^\d+$/.test(s ?? "")) return check(Number(s), 0, 127, "pitch", line);
  const m = String(s ?? "").match(/^([A-Ga-g])([#b]*)(-?\d+)$/);
  if (!m) throw new PartError(`line ${line}: "${s ?? ""}" is not a pitch`);
  const base = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1].toLowerCase()];
  let acc = 0;
  for (const ch of m[2]) acc += ch === "#" ? 1 : -1;
  return check((Number(m[3]) + 1) * 12 + base + acc, 0, 127, "pitch", line);
}

function ramp(b0, v0, b1, v1, line) {
  if (b1 <= b0) throw new PartError(`line ${line}: a change must end after it starts`);
  const pts = [];
  const n = Math.max(1, Math.round((b1 - b0) / RAMP_STEP));
  for (let i = 0; i <= n; i++) pts.push([b0 + ((b1 - b0) * i) / n, v0 + ((v1 - v0) * i) / n]);
  return pts;
}

/** Parse a note list into timed MIDI events. */
export function parseNotes(text) {
  const ev = []; // { beat, order, bytes }; order sorts events at the same beat
  let program = null, bendRange = 2, notes = 0, lastBeat = 0;
  const bends = [], ccs = new Set();
  String(text).split("\n").forEach((raw, i) => {
    const line = i + 1;
    const t = raw.split(/(?:^|\s)#/)[0].trim(); // "#" after a space is a comment; F#5 is a pitch
    if (!t) return;
    const [cmd, ...a] = t.split(/\s+/);
    const arrow = a.indexOf("->");
    switch (cmd) {
      case "title":
        break;
      case "tempo":
        throw new PartError(`line ${line}: a part follows the song's tempo, so it has no tempo command. Write rubato into the note starts and lengths.`);
      case "program":
        program = check(num(a[0], "program", line), 0, 127, "program", line);
        break;
      case "bendrange":
        bendRange = check(num(a[0], "bendrange", line), 1, 24, "bendrange", line);
        break;
      case "note": {
        const p = pitch(a[0], line), start = num(a[1], "start", line), len = num(a[2], "length", line);
        const vel = check(Math.round(num(a[3], "velocity", line)), 1, 127, "velocity", line);
        if (start < 0 || len <= 0) throw new PartError(`line ${line}: a note needs a start of 0 or more and a length above 0`);
        ev.push({ beat: start, order: 3, bytes: [0x90, p, vel] });
        ev.push({ beat: start + len, order: 1, bytes: [0x80, p, 0] });
        notes++;
        lastBeat = Math.max(lastBeat, start + len);
        break;
      }
      case "cc": {
        const n = check(num(a[0], "controller", line), 0, 127, "controller", line);
        const pts = arrow < 0 ? [[num(a[1], "beat", line), num(a[2], "value", line)]]
          : ramp(num(a[1], "beat", line), num(a[2], "value", line), num(a[4], "beat", line), num(a[5], "value", line), line);
        let last = null;
        for (const [b, v] of pts) {
          if (b < 0) throw new PartError(`line ${line}: beat ${b} is before the start`);
          const val = check(Math.round(v), 0, 127, "value", line);
          if (val !== last) ev.push({ beat: b, order: 2, bytes: [0xb0, n, val] });
          last = val;
        }
        ccs.add(n);
        break;
      }
      case "bend": {
        const pts = arrow < 0 ? [[num(a[0], "beat", line), num(a[1], "semitones", line)]]
          : ramp(num(a[0], "beat", line), num(a[1], "semitones", line), num(a[3], "beat", line), num(a[4], "semitones", line), line);
        for (const [b, s] of pts) {
          if (b < 0) throw new PartError(`line ${line}: beat ${b} is before the start`);
          bends.push({ b, s, line });
        }
        break;
      }
      default:
        throw new PartError(`line ${line}: unknown command "${cmd}". Commands: program, note, cc, bend, bendrange.`);
    }
  });
  if (!notes) throw new PartError("The part has no notes.");
  for (const { b, s, line } of bends) {
    check(s, -bendRange, bendRange, "bend", line);
    const v = Math.max(0, Math.min(16383, Math.round(8192 + (s / bendRange) * 8192)));
    ev.push({ beat: b, order: 2, bytes: [0xe0, v & 127, v >> 7] });
  }
  return { ev, program, bendRange, notes, beats: lastBeat, controllers: [...ccs].sort((x, y) => x - y), pitchBend: bends.length > 0 };
}

function vlq(n) {
  const out = [n & 127];
  while ((n >>= 7)) out.unshift((n & 127) | 128);
  return out;
}

/** Build a type 0 Standard MIDI File from parsed events. */
export function buildMidi({ ev, program, bendRange, pitchBend }, title = "") {
  const head = [];
  if (title) {
    const b = [...Buffer.from(title, "utf8")];
    head.push({ beat: 0, order: -3, bytes: [0xff, 0x03, ...vlq(b.length), ...b] });
  }
  if (program !== null) head.push({ beat: 0, order: -2, bytes: [0xc0, program] });
  if (pitchBend) {
    // Tell the instrument the pitch-bend range (RPN 0).
    head.push(...[[0xb0, 101, 0], [0xb0, 100, 0], [0xb0, 6, bendRange], [0xb0, 38, 0], [0xb0, 101, 127], [0xb0, 100, 127]]
      .map((bytes, i) => ({ beat: 0, order: -1 + i / 10, bytes })));
  }
  const all = [...head, ...ev].map((e, i) => ({ ...e, tick: Math.round(e.beat * PPQ), i }));
  all.sort((x, y) => x.tick - y.tick || x.order - y.order || x.i - y.i);
  const body = [];
  let now = 0;
  for (const e of all) {
    body.push(...vlq(e.tick - now), ...e.bytes);
    now = e.tick;
  }
  body.push(0, 0xff, 0x2f, 0x00);
  const len = body.length;
  return Buffer.from([
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, (PPQ >> 8) & 255, PPQ & 255,
    0x4d, 0x54, 0x72, 0x6b, (len >>> 24) & 255, (len >> 16) & 255, (len >> 8) & 255, len & 255, ...body,
  ]);
}

const safePartName = (s) => String(s ?? "").replace(/[^\w .-]+/g, "").trim().replace(/\s+/g, " ");

export const partFiles = (songDir, name) => {
  const safe = safePartName(name);
  if (!safe) throw new Error("Give the part a name made of letters or numbers, for example \"Bass\" or \"Ranat intro\".");
  const dir = path.join(songDir, PARTS_DIR);
  return { name: safe, dir, notes: path.join(dir, `${safe}.notes`), midi: path.join(dir, `${safe}.mid`) };
};

/** Write a part's note list and MIDI file into the song folder. */
export async function writePart(songDir, name, text) {
  if (String(text ?? "").length > MAX_TEXT) throw new Error(`The note list is longer than ${MAX_TEXT / 1024} KB. Split the part.`);
  const files = partFiles(songDir, name);
  let parsed;
  try {
    parsed = parseNotes(text);
  } catch (e) {
    if (e instanceof PartError) throw new Error(`${e.message}\n\nFormat:\n${FORMAT}`);
    throw e;
  }
  await fs.mkdir(files.dir, { recursive: true });
  await fs.writeFile(files.notes, String(text));
  await fs.writeFile(files.midi, buildMidi(parsed, files.name));
  return {
    part: files.name,
    notes_file: files.notes,
    midi_file: files.midi,
    notes: parsed.notes,
    beats: Math.round(parsed.beats * 1000) / 1000,
    program: parsed.program,
    controllers: parsed.controllers,
    pitch_bend: parsed.pitchBend,
  };
}

/** List the parts written for a song. */
export async function listParts(songDir) {
  let names = [];
  try {
    names = await fs.readdir(path.join(songDir, PARTS_DIR));
  } catch {
    return [];
  }
  return names.filter((n) => n.endsWith(".notes")).sort().map((n) => n.slice(0, -".notes".length));
}

/** Read a part's note list back. */
export async function readPart(songDir, name) {
  const files = partFiles(songDir, name);
  try {
    return { part: files.name, notes: await fs.readFile(files.notes, "utf8"), midi_file: files.midi };
  } catch {
    const parts = await listParts(songDir);
    throw new Error(`No part named "${name}". Parts: ${parts.join(", ") || "none yet"}.`);
  }
}
