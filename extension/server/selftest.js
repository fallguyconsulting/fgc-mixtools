// Self-test song: generated stems that exercise every mixtools tool without
// touching the person's own songs. The audio is the same on every Mac, so
// results can be compared between machines.

import { promises as fs } from "node:fs";
import path from "node:path";

import * as ardour from "./ardour.js";
import { encodeWavFloat } from "./audio.js";
import { ARCHIVES } from "./archive.js";

export const SELFTEST_SONG = "Mixtools Self-Test";
export const SELFTEST_AUDIO = path.join(ardour.WORKSPACE, "Self-Test Audio");
const MARKER = "mixtools-selftest.json";

const SR = 48000;
const BEAT = 0.5;            // 120 BPM
const BARS = 12;             // 4 beats a bar: 24 s of music
const SECONDS = BARS * 4 * BEAT + 1.5; // plus a ring-out tail for mastering
const CHORUS = [8, 16];      // backing vocals sing here

// One chord per bar: A minor, F, C, G.
const CHORDS = [
  { root: 110.0, notes: [220.0, 261.63, 329.63] },
  { root: 87.31, notes: [174.61, 220.0, 261.63] },
  { root: 130.81, notes: [261.63, 329.63, 392.0] },
  { root: 98.0, notes: [196.0, 246.94, 293.66] },
];
const chordAt = (t) => CHORDS[Math.floor(t / (4 * BEAT)) % CHORDS.length];

// Lead vocal phrases: one per bar, 1.5 s long, with a 0.5 s gap after it.
// Each starts with an "s" sound, then four sung notes.
const PHRASE_S = 0.12;
const PHRASES = Array.from({ length: BARS }, (_, i) => {
  const start = i * 2 + 0.25;
  const chord = CHORDS[i % CHORDS.length];
  const melody = [chord.notes[0], chord.notes[1], chord.notes[2], chord.notes[1]];
  // "s" loudness spread evenly over 0.3 to 1.0, in a shuffled order.
  const s_gain = 0.3 + (0.7 * ((i * 5) % BARS)) / (BARS - 1);
  return { start, end: start + 1.5, s_gain, loud_s: s_gain > 0.75, melody };
});

/** Seeded random numbers, so the noise is identical on every run. */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 * 2 - 1;
  };
}

const buffer = () => new Float32Array(Math.round(SECONDS * SR));
const dbToGain = (d) => Math.pow(10, d / 20);

function normalizePeak(ch, peakDb) {
  let peak = 0;
  for (const chan of ch) for (const v of chan) peak = Math.max(peak, Math.abs(v));
  const g = peak > 0 ? dbToGain(peakDb) / peak : 0;
  for (const chan of ch) for (let i = 0; i < chan.length; i++) chan[i] *= g;
  return ch;
}

function kick() {
  const out = buffer();
  for (let b = 0; b < BARS * 4; b++) {
    const s0 = Math.round(b * BEAT * SR);
    let phase = 0;
    for (let i = 0; i < 0.35 * SR && s0 + i < out.length; i++) {
      const t = i / SR;
      phase += (2 * Math.PI * (45 + 75 * Math.exp(-t / 0.03))) / SR;
      out[s0 + i] += Math.sin(phase) * Math.exp(-t / 0.12);
    }
  }
  return normalizePeak([out], -3);
}

function snare() {
  const out = buffer();
  const rnd = random(2);
  for (let b = 1; b < BARS * 4; b += 2) {
    const s0 = Math.round(b * BEAT * SR);
    for (let i = 0; i < 0.25 * SR && s0 + i < out.length; i++) {
      const t = i / SR;
      out[s0 + i] += rnd() * Math.exp(-t / 0.06) * 0.8 + Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t / 0.04) * 0.5;
    }
  }
  return normalizePeak([out], -4);
}

function bass() {
  const out = buffer();
  for (let b = 0; b < BARS * 8; b++) { // eighth notes
    const t0 = b * BEAT / 2;
    const f = chordAt(t0).root;
    const s0 = Math.round(t0 * SR);
    for (let i = 0; i < (BEAT / 2) * SR && s0 + i < out.length; i++) {
      const t = i / SR;
      const env = Math.min(1, t / 0.005) * Math.exp(-t / 0.2) * Math.min(1, ((BEAT / 2) - t) / 0.01);
      let v = 0;
      for (let k = 1; k <= 5; k++) v += Math.sin(2 * Math.PI * f * k * t) / (k * k);
      out[s0 + i] += v * env;
    }
  }
  return normalizePeak([out], -8);
}

/** Stereo keys: a held chord per bar, each side slightly detuned. Deliberately loud. */
function keys() {
  const L = buffer(), R = buffer();
  for (let bar = 0; bar < BARS; bar++) {
    const t0 = bar * 4 * BEAT;
    const s0 = Math.round(t0 * SR);
    const len = 4 * BEAT * SR;
    for (const f of CHORDS[bar % CHORDS.length].notes) {
      for (let i = 0; i < len && s0 + i < L.length; i++) {
        const t = i / SR;
        const env = Math.min(1, t / 0.01) * (0.4 + 0.6 * Math.exp(-t / 0.4)) * Math.min(1, (len - i) / (0.02 * SR));
        L[s0 + i] += (Math.sin(2 * Math.PI * f * 0.998 * t) + 0.3 * Math.sin(4 * Math.PI * f * 0.998 * t)) * env;
        R[s0 + i] += (Math.sin(2 * Math.PI * f * 1.002 * t) + 0.3 * Math.sin(4 * Math.PI * f * 1.002 * t)) * env;
      }
    }
  }
  return normalizePeak([L, R], -2);
}

/** A sung vowel: harmonics shaped by formant peaks, with vibrato. */
function sing(out, start, end, notes, formants, rnd, gain) {
  const s0 = Math.round(start * SR);
  const s1 = Math.round(end * SR);
  const noteLen = (s1 - s0) / notes.length;
  let phase = 0;
  for (let i = s0; i < s1 && i < out.length; i++) {
    const t = (i - s0) / SR;
    const n = Math.min(notes.length - 1, Math.floor((i - s0) / noteLen));
    const vib = t > 0.3 ? Math.pow(2, (20 / 1200) * Math.sin(2 * Math.PI * 5.5 * t)) : 1;
    const f0 = notes[n] * vib;
    phase += (2 * Math.PI * f0) / SR;
    let v = 0;
    for (let k = 1; k * f0 < 8000; k++) {
      const fk = k * f0;
      let a = 0;
      for (const [fc, bw, amp] of formants) a += amp * Math.exp(-0.5 * ((fk - fc) / bw) ** 2);
      v += (a / Math.sqrt(k)) * Math.sin(k * phase);
    }
    const env = Math.min(1, t / 0.03) * Math.min(1, (s1 - i) / (0.08 * SR));
    out[i] += (v + rnd() * 0.002) * env * gain;
  }
}

/** An "s": noise with its low end filtered off. */
function hiss(out, start, seconds, rnd, gain) {
  const s0 = Math.round(start * SR);
  const n = Math.round(seconds * SR);
  let x1 = 0, y1 = 0, y2 = 0, z1 = 0;
  const a = Math.exp((-2 * Math.PI * 4000) / SR);
  for (let i = 0; i < n && s0 + i < out.length; i++) {
    const x = rnd();
    y1 = a * (y1 + x - x1); // one-pole high-pass, twice
    x1 = x;
    const y = a * (y2 + y1 - z1);
    z1 = y1;
    y2 = y;
    const env = Math.sin((Math.PI * i) / n);
    out[s0 + i] += y * env * gain;
  }
}

const AH = [[700, 130, 1], [1220, 150, 0.5], [2600, 250, 0.25]];
const OO = [[320, 80, 1], [870, 120, 0.35], [2250, 250, 0.1]];

/** Lead vocal, deliberately quiet so the starting balance has work to do. */
function leadVocal() {
  const out = buffer();
  const rnd = random(3);
  for (const p of PHRASES) {
    hiss(out, p.start, PHRASE_S, rnd, p.s_gain);
    sing(out, p.start + PHRASE_S, p.end, p.melody, AH, rnd, 0.25);
  }
  return normalizePeak([out], -16);
}

/** Backing vocals: a softer "oo" a third above the lead, in the chorus only. */
function backingVocals() {
  const out = buffer();
  const rnd = random(4);
  for (const p of PHRASES.filter((x) => x.start >= CHORUS[0] && x.start < CHORUS[1])) {
    sing(out, p.start + PHRASE_S, p.end, p.melody.map((f) => f * 1.26), OO, rnd, 0.2);
  }
  return normalizePeak([out], -20);
}

const STEMS = [
  ["Kick", kick],
  ["Snare", snare],
  ["Bass", bass],
  ["Keys", keys],
  ["Lead Vocal", leadVocal],
  ["Backing Vocals", backingVocals],
];

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Remove the previous self-test song and everything made from it. Only folders mixtools marked as its own. */
async function removePrevious() {
  const dir = path.join(ardour.SONGS, SELFTEST_SONG);
  if (!(await exists(dir))) return [];
  if (!(await exists(path.join(dir, MARKER)))) {
    throw new Error(`A song named "${SELFTEST_SONG}" exists at ${dir}, and the self-test did not make it. Rename that song folder, then try again.`);
  }
  const removed = [];
  for (const p of [dir, path.join(ardour.BOUNCES, SELFTEST_SONG), path.join(ardour.MASTERS, SELFTEST_SONG)]) {
    if (await exists(p)) {
      await fs.rm(p, { recursive: true, force: true });
      removed.push(p);
    }
  }
  try {
    for (const n of await fs.readdir(ARCHIVES)) {
      if (n.startsWith(`${SELFTEST_SONG} (archive `) && n.endsWith(".zip")) {
        await fs.rm(path.join(ARCHIVES, n), { force: true });
        removed.push(path.join(ARCHIVES, n));
      }
    }
  } catch {}
  return removed;
}

/** Write the test stems into a fresh folder. Returns their paths in track order. */
export async function writeStems(dir) {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  const files = [];
  for (const [name, make] of STEMS) {
    const file = path.join(dir, `${name}.wav`);
    await fs.writeFile(file, encodeWavFloat({ sampleRate: SR, channels: make() }));
    files.push(file);
  }
  return files;
}

/** Write the test stems, replace any earlier self-test song, and open the new one in Ardour. */
export async function selftestSong() {
  if (await ardour.isRunning()) {
    let info = null;
    try {
      info = await ardour.sessionInfo();
    } catch {}
    throw new Error(`Ardour is open${info ? ` with "${info.sessionName}"` : ""}. Ask the person to save and quit Ardour (Session menu, then Quit), then try again.`);
  }
  const removed = await removePrevious();

  const files = await writeStems(SELFTEST_AUDIO);

  const song = await ardour.newSong(SELFTEST_SONG, files, STEMS.map(([n]) => n));
  await fs.writeFile(path.join(song.path, MARKER), JSON.stringify({ made_by: "mixtools selftest_song", time: new Date().toISOString() }, null, 2));

  const verse2 = PHRASES.find((p) => p.start >= CHORUS[1]);
  return {
    song: song.song,
    path: song.path,
    imported: song.imported,
    removed_previous: removed,
    audio: {
      seconds: SECONDS,
      tempo_bpm: 120,
      tracks: STEMS.map(([n]) => n),
      sections: { verse_1: "0:00-0:08", chorus: "0:08-0:16 (backing vocals sing)", verse_2: "0:16-0:24" },
      lead_vocal_phrases: PHRASES.map((p) => ({ start: p.start, end: p.end, s_sound_at: p.start, loud_s: p.loud_s })),
      expected: {
        starting_balance: "The lead vocal starts quiet and the keys loud, so mix_starting_balance raises the vocal against the keys.",
        s_sounds: `${PHRASES.length} s sounds, one at the start of each lead vocal phrase; the ${PHRASES.filter((p) => p.loud_s).length} marked loud_s are the loudest.`,
        moment_time: 12,
        clean_span: { start: verse2.start, end: verse2.end },
        vocal_tracks: ["Lead Vocal", "Backing Vocals"],
      },
    },
  };
}
