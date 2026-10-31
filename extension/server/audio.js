// Audio file reading and measurement. No dependencies: WAV is parsed here, and
// every other format is converted to WAV with macOS's built-in afconvert.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const BANDS = [
  { name: "sub", lo: 20, hi: 60 },
  { name: "bass", lo: 60, hi: 250 },
  { name: "low_mid", lo: 250, hi: 500 },
  { name: "mid", lo: 500, hi: 2000 },
  { name: "high_mid", lo: 2000, hi: 4000 },
  { name: "presence", lo: 4000, hi: 6000 },
  { name: "brilliance", lo: 6000, hi: 20000 },
];

const CACHE_DIR = path.join(os.tmpdir(), "mixtools-cache");

// ---------------------------------------------------------------------------
// Reading

/** Parse a WAV file into { sampleRate, channels: Float32Array[] }. */
export function parseWav(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a WAV file");
  }
  let fmt = null;
  let data = null;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      let format = buf.readUInt16LE(body);
      const channels = buf.readUInt16LE(body + 2);
      const sampleRate = buf.readUInt32LE(body + 4);
      const bits = buf.readUInt16LE(body + 14);
      if (format === 0xfffe && size >= 26) {
        format = buf.readUInt16LE(body + 24); // first two bytes of the SubFormat GUID
      }
      fmt = { format, channels, sampleRate, bits };
    } else if (id === "data") {
      data = { start: body, size: Math.min(size, buf.length - body) };
    }
    off = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error("WAV file is missing its format or data chunk");

  const { format, channels: nch, sampleRate, bits } = fmt;
  const bytes = bits / 8;
  const frames = Math.floor(data.size / (bytes * nch));
  const channels = Array.from({ length: nch }, () => new Float32Array(frames));
  let p = data.start;

  const read =
    format === 3 && bits === 32 ? (o) => buf.readFloatLE(o)
    : format === 3 && bits === 64 ? (o) => buf.readDoubleLE(o)
    : format === 1 && bits === 16 ? (o) => buf.readInt16LE(o) / 32768
    : format === 1 && bits === 24 ? (o) => buf.readIntLE(o, 3) / 8388608
    : format === 1 && bits === 32 ? (o) => buf.readInt32LE(o) / 2147483648
    : format === 1 && bits === 8 ? (o) => (buf.readUInt8(o) - 128) / 128
    : null;
  if (!read) throw new Error(`unsupported WAV encoding (format ${format}, ${bits} bit)`);

  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++) {
      channels[c][i] = read(p);
      p += bytes;
    }
  }
  return { sampleRate, channels, isFloat: format === 3 };
}

/** Write 32-bit float WAV bytes. */
export function encodeWavFloat({ sampleRate, channels }) {
  const nch = channels.length;
  const frames = channels[0].length;
  const dataSize = frames * nch * 4;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(3, 20);
  buf.writeUInt16LE(nch, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * nch * 4, 28);
  buf.writeUInt16LE(nch * 4, 32);
  buf.writeUInt16LE(32, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataSize, 40);
  let p = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++) {
      buf.writeFloatLE(channels[c][i], p);
      p += 4;
    }
  }
  return buf;
}

/** Return a path to a WAV version of any audio file macOS can read. */
export async function asWav(file) {
  const head = Buffer.alloc(12);
  const fh = await fs.open(file, "r");
  try {
    await fh.read(head, 0, 12, 0);
  } finally {
    await fh.close();
  }
  if (head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WAVE") {
    return file;
  }
  const st = await fs.stat(file);
  const key = createHash("sha1").update(`${path.resolve(file)}:${st.size}:${st.mtimeMs}`).digest("hex");
  const out = path.join(CACHE_DIR, `${key}.wav`);
  try {
    await fs.access(out);
    return out;
  } catch {}
  await fs.mkdir(CACHE_DIR, { recursive: true });
  try {
    await run("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEF32", file, out]);
  } catch (e) {
    throw new Error(`macOS could not read this audio file: ${path.basename(file)}`);
  }
  return out;
}

/** Load any audio file, optionally cut to [start, end) seconds. */
export async function loadAudio(file, { start, end } = {}) {
  const audio = parseWav(await fs.readFile(await asWav(file)));
  const sr = audio.sampleRate;
  const len = audio.channels[0].length;
  const a = Math.max(0, Math.floor((start ?? 0) * sr));
  const b = Math.min(len, end != null ? Math.floor(end * sr) : len);
  if (a > 0 || b < len) {
    audio.channels = audio.channels.map((ch) => ch.slice(a, Math.max(a, b)));
  }
  if (audio.channels[0].length < sr * 0.5) {
    throw new Error("audio is shorter than half a second; nothing to measure");
  }
  return audio;
}

// ---------------------------------------------------------------------------
// Loudness (ITU-R BS.1770-4, EBU R128, EBU Tech 3342)

function biquad(x, b0, b1, b2, a1, a2) {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    const o = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = v; y2 = y1; y1 = o;
    y[i] = o;
  }
  return y;
}

/** K-weighting filter, coefficients derived for any sample rate (as in libebur128). */
function kWeight(x, sr) {
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / sr);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf = biquad(
    x,
    (Vh + (Vb * K) / Q + K * K) / a0,
    (2 * (K * K - Vh)) / a0,
    (Vh - (Vb * K) / Q + K * K) / a0,
    (2 * (K * K - 1)) / a0,
    (1 - K / Q + K * K) / a0,
  );
  f0 = 38.13547087602444; Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / sr);
  a0 = 1 + K / Q + K * K;
  return biquad(shelf, 1, -2, 1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0);
}

const toLufs = (power) => (power > 0 ? -0.691 + 10 * Math.log10(power) : -Infinity);

/** Mean power of each window of `win` samples, stepping `hop` samples, summed over channels. */
function windowPowers(weighted, win, hop) {
  const len = weighted[0].length;
  const out = [];
  // Prefix sums of squared samples make each window O(1).
  const prefix = weighted.map((ch) => {
    const p = new Float64Array(ch.length + 1);
    for (let i = 0; i < ch.length; i++) p[i + 1] = p[i] + ch[i] * ch[i];
    return p;
  });
  for (let s = 0; s + win <= len; s += hop) {
    let sum = 0;
    for (const p of prefix) sum += (p[s + win] - p[s]) / win;
    out.push(sum);
  }
  return out;
}

function loudness(channels, sr) {
  // BS.1770 weights left, right and center at 1.0. Surround channels are not expected.
  const weighted = channels.slice(0, 2).map((ch) => kWeight(ch, sr));

  const blocks = windowPowers(weighted, Math.round(0.4 * sr), Math.round(0.1 * sr));
  const absGated = blocks.filter((p) => toLufs(p) > -70);
  let integrated = -Infinity;
  if (absGated.length) {
    const rel = toLufs(absGated.reduce((a, b) => a + b, 0) / absGated.length) - 10;
    const gated = absGated.filter((p) => toLufs(p) > rel);
    if (gated.length) integrated = toLufs(gated.reduce((a, b) => a + b, 0) / gated.length);
  }

  const short = windowPowers(weighted, Math.round(3 * sr), Math.round(0.1 * sr));
  const shortLufs = short.map(toLufs);
  let range = 0;
  const stAbs = short.filter((p) => toLufs(p) > -70);
  if (stAbs.length) {
    const rel = toLufs(stAbs.reduce((a, b) => a + b, 0) / stAbs.length) - 20;
    const vals = stAbs.map(toLufs).filter((l) => l > rel).sort((a, b) => a - b);
    if (vals.length > 1) {
      const pct = (q) => vals[Math.min(vals.length - 1, Math.round(q * (vals.length - 1)))];
      range = pct(0.95) - pct(0.1);
    }
  }
  return {
    integrated,
    range,
    shortTermMax: shortLufs.length ? Math.max(...shortLufs) : integrated,
    momentaryMax: blocks.length ? Math.max(...blocks.map(toLufs)) : integrated,
  };
}

// ---------------------------------------------------------------------------
// Peaks

/** True peak by 4x oversampling with a 48-tap windowed-sinc interpolator. */
function truePeak(ch) {
  const phases = 4, taps = 12;
  const half = taps / 2;
  const coef = [];
  for (let p = 1; p < phases; p++) {
    const frac = p / phases;
    const c = new Float64Array(taps);
    for (let k = 0; k < taps; k++) {
      const t = k - half + 1 - frac;
      const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
      const w = 0.5 * (1 + Math.cos((Math.PI * t) / (half + 1)));
      c[k] = sinc * w;
    }
    coef.push(c);
  }
  let peak = 0;
  for (let i = 0; i < ch.length; i++) {
    const v = Math.abs(ch[i]);
    if (v > peak) peak = v;
  }
  // An inter-sample peak can only beat the sample peak between samples that are
  // already near it, so skip quiet stretches.
  const floor = peak * 0.5;
  for (let i = half - 1; i < ch.length - half; i++) {
    if (Math.abs(ch[i]) < floor && Math.abs(ch[i + 1]) < floor) continue;
    for (const c of coef) {
      let s = 0;
      for (let k = 0; k < taps; k++) s += c[k] * ch[i - half + 1 + k];
      const v = Math.abs(s);
      if (v > peak) peak = v;
    }
  }
  return peak;
}

// ---------------------------------------------------------------------------
// Spectrum

function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k], ai = im[i + k];
        const br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ar + br; im[i + k] = ai + bi;
        re[i + k + len / 2] = ar - br; im[i + k + len / 2] = ai - bi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

export function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

/** Magnitude-squared spectrum of x[start .. start+n) after windowing. */
export function powerSpectrum(x, start, n, win) {
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = (x[start + i] ?? 0) * win[i];
  fftInPlace(re, im);
  const out = new Float64Array(n / 2 + 1);
  for (let k = 0; k <= n / 2; k++) out[k] = re[k] * re[k] + im[k] * im[k];
  return out;
}

export function monoMix(channels) {
  if (channels.length === 1) return channels[0];
  const m = new Float32Array(channels[0].length);
  for (const ch of channels) for (let i = 0; i < m.length; i++) m[i] += ch[i] / channels.length;
  return m;
}

/** Share of spectral energy in each band, in dB relative to the 20 Hz - 20 kHz total. */
function bandLevels(channels, sr) {
  const n = 8192;
  const x = monoMix(channels);
  const win = hann(n);
  const avg = new Float64Array(n / 2 + 1);
  const hop = Math.max(n / 2, Math.floor((x.length - n) / 600)); // at most ~600 frames
  let frames = 0;
  for (let s = 0; s + n <= x.length; s += hop) {
    const p = powerSpectrum(x, s, n, win);
    for (let k = 0; k < p.length; k++) avg[k] += p[k];
    frames++;
  }
  const hz = sr / n;
  const sumRange = (lo, hi) => {
    let s = 0;
    for (let k = Math.ceil(lo / hz); k <= Math.min(avg.length - 1, Math.floor(hi / hz)); k++) s += avg[k];
    return s;
  };
  const total = sumRange(20, 20000) || 1e-30;
  const out = {};
  for (const b of BANDS) out[b.name] = round(10 * Math.log10(Math.max(sumRange(b.lo, b.hi), 1e-30) / total), 1);
  return { levels: out, frames };
}

// ---------------------------------------------------------------------------
// Measure

const round = (v, d = 1) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const db = (v) => 20 * Math.log10(Math.max(v, 1e-12));

export async function measure(file, range = {}) {
  const audio = await loadAudio(file, range);
  const { sampleRate: sr, channels } = audio;
  const frames = channels[0].length;

  let samplePeak = 0, sumSq = 0, clipped = 0, overs = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const v = Math.abs(ch[i]);
      if (v > samplePeak) samplePeak = v;
      sumSq += ch[i] * ch[i];
      if (v >= 0.9999) clipped++;
      if (v > 1.0) overs++;
    }
  }
  const rms = Math.sqrt(sumSq / (frames * channels.length));
  const tp = Math.max(...channels.map(truePeak));
  const loud = loudness(channels, sr);

  let stereo = null;
  if (channels.length >= 2) {
    const [L, R] = channels;
    let lr = 0, ll = 0, rr = 0, mm = 0, ss = 0;
    for (let i = 0; i < frames; i++) {
      const l = L[i], r = R[i];
      lr += l * r; ll += l * l; rr += r * r;
      const m = (l + r) / 2, s = (l - r) / 2;
      mm += m * m; ss += s * s;
    }
    const correlation = ll && rr ? lr / Math.sqrt(ll * rr) : 1;
    const monoLoss = 10 * Math.log10(Math.max(mm, 1e-30) / Math.max((ll + rr) / 2, 1e-30));
    // Side-to-mid energy. Identical channels have no side energy at all, so cap
    // the figure at -60 dB and say the file is effectively mono.
    const width = Math.max(-60, 10 * Math.log10(Math.max(ss, 1e-30) / Math.max(mm, 1e-30)));
    stereo = {
      correlation: round(correlation, 2),
      width_db: round(width, 1),
      effectively_mono: width <= -60,
      mono_loss_db: round(monoLoss, 1),
      mono_warning: correlation < 0 || monoLoss < -3.5,
    };
  }

  const bands = bandLevels(channels, sr);
  return {
    file: path.basename(file),
    seconds: round(frames / sr, 2),
    sample_rate: sr,
    channels: channels.length,
    loudness_lufs: round(loud.integrated),
    loudness_range_lu: round(loud.range),
    short_term_max_lufs: round(loud.shortTermMax),
    momentary_max_lufs: round(loud.momentaryMax),
    sample_peak_dbfs: round(db(samplePeak)),
    true_peak_dbtp: round(db(tp)),
    rms_dbfs: round(db(rms)),
    crest_factor_db: round(db(samplePeak) - db(rms)),
    clipped_samples: clipped,
    over_full_scale_samples: overs,
    stereo,
    band_levels_db: bands.levels,
  };
}

// ---------------------------------------------------------------------------
// Compare

const BAND_WORDS = {
  sub: "deep bass (20-60 Hz)",
  bass: "bass (60-250 Hz)",
  low_mid: "low mids (250-500 Hz)",
  mid: "mids (500 Hz-2 kHz)",
  high_mid: "upper mids (2-4 kHz)",
  presence: "presence (4-6 kHz)",
  brilliance: "highs (6-20 kHz)",
};

export async function compare(fileA, fileB, rangeA = {}, rangeB = {}) {
  const [a, b] = await Promise.all([measure(fileA, rangeA), measure(fileB, rangeB)]);
  const diff = (k) => (a[k] != null && b[k] != null ? round(b[k] - a[k]) : null);
  const bandDiff = {};
  for (const band of BANDS) bandDiff[band.name] = round(b.band_levels_db[band.name] - a.band_levels_db[band.name]);

  // Band levels are shares of each file's own total energy, so loudness
  // differences do not hide or fake tone differences.
  const notes = [];
  const more = (v) => (v > 0 ? "more" : "less");
  for (const band of BANDS) {
    const v = bandDiff[band.name];
    if (v != null && Math.abs(v) >= 2) {
      notes.push({ size: Math.abs(v), text: `B has ${Math.abs(v)} dB ${more(v)} ${BAND_WORDS[band.name]} than A, relative to its overall level.` });
    }
  }
  const lu = diff("loudness_lufs");
  if (lu != null && Math.abs(lu) >= 1) notes.push({ size: Math.abs(lu), text: `B is ${Math.abs(lu)} LU ${lu > 0 ? "louder" : "quieter"} than A overall.` });
  const lra = diff("loudness_range_lu");
  if (lra != null && Math.abs(lra) >= 2) notes.push({ size: Math.abs(lra), text: `B's loud and quiet parts are ${Math.abs(lra)} LU ${lra > 0 ? "further apart" : "closer together"} than A's (loudness range).` });
  const crest = diff("crest_factor_db");
  if (crest != null && Math.abs(crest) >= 2) notes.push({ size: Math.abs(crest), text: `B's peaks stand ${Math.abs(crest)} dB ${crest > 0 ? "further above" : "closer to"} its average level than A's (${crest > 0 ? "punchier" : "more compressed"}).` });
  if (a.stereo && b.stereo) {
    const w = round(b.stereo.width_db - a.stereo.width_db);
    if (Math.abs(w) >= 3) notes.push({ size: Math.abs(w) / 2, text: `B sounds ${w > 0 ? "wider" : "narrower"} than A (${Math.abs(w)} dB ${more(w)} side energy).` });
  }
  if (b.true_peak_dbtp != null && b.true_peak_dbtp > 0) notes.push({ size: 99, text: `B's true peak is ${b.true_peak_dbtp} dBTP, above 0. It may distort on playback.` });
  if (b.clipped_samples > 0 && b.clipped_samples > (a.clipped_samples ?? 0)) notes.push({ size: 98, text: `B has ${b.clipped_samples} clipped samples.` });
  notes.sort((x, y) => y.size - x.size);

  return {
    a,
    b,
    difference_b_minus_a: {
      loudness_lu: lu,
      loudness_range_lu: lra,
      true_peak_db: diff("true_peak_dbtp"),
      crest_factor_db: crest,
      stereo_width_db: a.stereo && b.stereo ? round(b.stereo.width_db - a.stereo.width_db) : null,
      band_levels_db: bandDiff,
    },
    largest_differences: notes.slice(0, 5).map((n) => n.text),
  };
}
