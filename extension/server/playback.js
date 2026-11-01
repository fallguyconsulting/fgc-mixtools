// Playback preparation: set the level a listener would hear (matched to other
// files, or as a streaming service plays it) and simulate listening on a phone,
// in a car, or in mono. Never changes the file itself.

import { promises as fs } from "node:fs";

import { db, loadAudio, loudness, round, truePeak } from "./audio.js";
import { STREAMING_SERVICES, streamingGain } from "./master.js";

export const SIMULATIONS = ["phone", "car", "mono"];

// A phone speaker loses most of a song's energy with the bass, and a car
// cabin adds bass. These fixed offsets keep each simulation near the level it
// was asked for, the same for every file, so matched comparisons stay matched.
const SIMULATION_OFFSET_DB = { phone: 6, car: -6, mono: 0 };

// Whole-file loudness and true peak, cached by file identity.
const levelCache = new Map();

export async function fileLevel(file) {
  const st = await fs.stat(file);
  const key = `${file}:${st.size}:${st.mtimeMs}`;
  if (levelCache.has(key)) return levelCache.get(key);
  const audio = await loadAudio(file);
  const level = {
    lufs: loudness(audio.channels, audio.sampleRate).integrated,
    true_peak_db: db(Math.max(...audio.channels.map(truePeak))),
  };
  if (!Number.isFinite(level.lufs)) throw new Error(`${file} is silent.`);
  levelCache.set(key, level);
  return level;
}

// ---------------------------------------------------------------------------
// Filters (RBJ cookbook biquads)

function biquad(x, sr, type, freq, { q = Math.SQRT1_2, gainDb = 0 } = {}) {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * Math.min(freq, sr * 0.45)) / sr;
  const cos = Math.cos(w0), sin = Math.sin(w0), alpha = sin / (2 * q);
  let b0, b1, b2, a0, a1, a2;
  if (type === "lowpass") {
    b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = b0; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
  } else if (type === "highpass") {
    b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = b0; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
  } else if (type === "peak") {
    b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A;
  } else if (type === "lowshelf" || type === "highshelf") {
    const s = type === "lowshelf" ? 1 : -1;
    const k = 2 * Math.sqrt(A) * alpha;
    b0 = A * (A + 1 - s * (A - 1) * cos + k);
    b1 = 2 * s * A * (A - 1 - s * (A + 1) * cos);
    b2 = A * (A + 1 - s * (A - 1) * cos - k);
    a0 = A + 1 + s * (A - 1) * cos + k;
    a1 = -2 * s * (A - 1 + s * (A + 1) * cos);
    a2 = A + 1 + s * (A - 1) * cos - k;
  } else {
    throw new Error(`unknown filter ${type}`);
  }
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    const o = (b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = v; y2 = y1; y1 = o;
    y[i] = o;
  }
  return y;
}

const chain = (x, sr, stages) => stages.reduce((sig, [type, freq, opts]) => biquad(sig, sr, type, freq, opts), x);

const monoSum = (channels) => {
  if (channels.length === 1) return channels[0];
  const m = new Float32Array(channels[0].length);
  for (const ch of channels) for (let i = 0; i < m.length; i++) m[i] += ch[i] / channels.length;
  return m;
};

/** Low rumble like tyre and engine noise, at a fixed level below the song. */
function roadNoise(n, sr, rms) {
  let seed = 12345;
  const white = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    seed = (seed * 16807) % 2147483647;
    white[i] = (seed / 2147483647) * 2 - 1;
  }
  const rumble = chain(white, sr, [["lowpass", 250], ["lowpass", 250], ["highpass", 30]]);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += rumble[i] * rumble[i];
  const k = rms / Math.sqrt(sum / n || 1);
  for (let i = 0; i < n; i++) rumble[i] *= k;
  return rumble;
}

/**
 * Simulate a listening situation:
 * - phone: one small speaker; no bass below about 350 Hz, a little extra bite
 *   around 3 kHz, highs rolled off above about 10 kHz.
 * - car: cabin bass boost below about 100 Hz, softer highs, and road rumble
 *   about 20 dB below the song's loudness, which hides quiet parts.
 * - mono: left and right summed, as on one speaker.
 */
function simulate(channels, sr, kind, songLufs) {
  if (kind === "mono" || kind === "phone") {
    const m = monoSum(channels);
    const out = kind === "phone"
      ? chain(m, sr, [["highpass", 350], ["highpass", 350], ["peak", 3000, { q: 1, gainDb: 3 }], ["lowpass", 10000]])
      : m;
    return channels.map(() => out);
  }
  if (kind === "car") {
    // Road rumble sits about 20 dB below the song, in RMS terms. The playback
    // gain applies to both afterwards.
    const rumbleRms = Math.pow(10, (songLufs - 20 + 0.691) / 20);
    const noise = roadNoise(channels[0].length, sr, rumbleRms);
    return channels.map((ch) => {
      const y = chain(ch, sr, [["lowshelf", 100, { gainDb: 6 }], ["highshelf", 6000, { gainDb: -4 }]]);
      for (let i = 0; i < y.length; i++) y[i] += noise[i];
      return y;
    });
  }
  throw new Error(`Unknown simulation "${kind}". Use one of: ${SIMULATIONS.join(", ")}.`);
}

// ---------------------------------------------------------------------------

/**
 * Work out the playback gain and build the audio to play.
 * Exactly one of match_with, as_heard_on, or level_lufs may set the level.
 */
export async function preparePlayback(file, opts) {
  const levelOpts = ["match_with", "as_heard_on", "level_lufs"].filter((k) => opts[k] != null);
  if (levelOpts.length > 1) throw new Error(`Use only one of match_with, as_heard_on, or level_lufs (got ${levelOpts.join(", ")}).`);
  if (opts.simulate != null && !SIMULATIONS.includes(opts.simulate)) {
    throw new Error(`Unknown simulation "${opts.simulate}". Use one of: ${SIMULATIONS.join(", ")}.`);
  }
  if (opts.as_heard_on != null && !STREAMING_SERVICES.includes(opts.as_heard_on)) {
    throw new Error(`Unknown service "${opts.as_heard_on}". Use one of: ${STREAMING_SERVICES.join(", ")}.`);
  }
  if (!levelOpts.length && opts.simulate == null) return null; // play the file as it is

  const own = await fileLevel(file);
  let gainDb = 0;
  let level = null;
  if (opts.match_with) {
    // Play every file in the group at the quietest one's loudness. Files are
    // only ever turned down, so nothing clips.
    const group = [...new Set([file, ...opts.match_with])];
    const levels = await Promise.all(group.map(fileLevel));
    const target = Math.min(...levels.map((l) => l.lufs));
    gainDb = target - own.lufs;
    level = { matched_at_lufs: round(target), group_size: group.length };
  } else if (opts.as_heard_on) {
    gainDb = streamingGain(opts.as_heard_on, own.lufs, own.true_peak_db);
    level = { service: opts.as_heard_on };
  } else if (opts.level_lufs != null) {
    gainDb = opts.level_lufs - own.lufs;
    level = {};
  }

  const audio = await loadAudio(file, { start: opts.start, end: opts.end });
  const sr = audio.sampleRate;
  let channels = audio.channels;
  if (opts.simulate) channels = simulate(channels, sr, opts.simulate, own.lufs);

  const simDb = opts.simulate ? SIMULATION_OFFSET_DB[opts.simulate] : 0;
  const g = Math.pow(10, (gainDb + simDb) / 20);
  let peak = 0;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i] * g));
  // Never send overs to the speakers. If the gain or a simulation's bass boost
  // would clip, turn this playback down and say so.
  let safety = 0;
  if (peak > 1) safety = db(1 / peak);
  const total = Math.pow(10, (gainDb + simDb + safety) / 20);
  const out = channels.map((ch) => {
    const y = new Float32Array(ch.length);
    for (let i = 0; i < ch.length; i++) y[i] = ch[i] * total;
    return y;
  });

  return {
    audio: { sampleRate: sr, channels: out },
    info: {
      file_lufs: round(own.lufs),
      gain_db: round(gainDb + safety),
      played_at_lufs: round(own.lufs + gainDb + safety),
      ...(opts.simulate ? { note: "played_at_lufs is the level before the simulation. The simulation changes how loud it sounds, the same way for every file." } : {}),
      ...(level ?? {}),
      ...(opts.simulate ? { simulate: opts.simulate } : {}),
      ...(safety < -0.05 ? { turned_down_to_avoid_clipping_db: round(-safety) } : {}),
    },
  };
}
