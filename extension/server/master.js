// Mastering: turn a finished mix bounce into a delivery file, and check a file
// against the release targets. Everything runs offline on the bounce, so the
// Ardour session is never touched.

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { db, loadAudio, loudness, measure, measureAudio, peakEnvelope, round, truePeak } from "./audio.js";

const run = promisify(execFile);

const fromDb = (v) => Math.pow(10, v / 20);

// Silence and click thresholds, in dBFS.
const SILENCE_DB = -60;
const RING_OUT_DB = -40;
const CLICK_DB = -40;
const CUT_OFF_DB = -20;
const MAX_EXTRA_GAIN_DB = 12;

/** Ceiling the release targets call for: -1 dBTP, or -2 dBTP above -14 LUFS. */
export const defaultCeiling = (lufs) => (lufs > -14 ? -2 : -1);

// ---------------------------------------------------------------------------
// Limiter

/** Sliding minimum of r over [j, j + win), for every j, written to out. */
function forwardMin(r, win, out, q) {
  const n = r.length;
  let head = 0, tail = 0;
  for (let j = n - 1; j >= 0; j--) {
    while (tail > head && r[q[tail - 1]] >= r[j]) tail--;
    q[tail++] = j;
    while (q[head] >= j + win) head++;
    out[j] = r[q[head]];
  }
}

/**
 * Lookahead true-peak limiter. For a makeup gain `gain` and a ceiling, fills
 * buf.g with the per-sample gain that keeps env[i] * gain * g[i] at or below
 * the ceiling. Gain falls over `lookahead` samples before each peak (no
 * instant jumps, so no clicks) and recovers with a `release` time constant.
 */
function limiterGain(env, gain, ceiling, sr, buf, { lookaheadMs = 5, releaseMs = 120 } = {}) {
  const n = env.length;
  const win = Math.max(1, Math.round((lookaheadMs / 1000) * sr));
  const { need, held, q, g } = buf;
  for (let i = 0; i < n; i++) {
    const p = env[i] * gain;
    need[i] = p > ceiling ? ceiling / p : 1;
  }
  // held[j] is the smallest gain any sample in the next `win` samples needs.
  forwardMin(need, win, held, q);
  // Release: rise back toward 1 smoothly, never above what held allows.
  const a = Math.exp(-1 / ((releaseMs / 1000) * sr));
  let prev = 1;
  for (let j = 0; j < n; j++) {
    const h = held[j];
    prev = h < prev ? h : a * prev + (1 - a) * h;
    held[j] = prev;
  }
  // Average the last `win` held values. Every one of them covers sample i, so
  // the average never exceeds what sample i needs. Time before the start
  // counts as held[0], which covers every sample in the first window.
  const pre = held[0];
  let sum = win * pre;
  for (let i = 0; i < n; i++) {
    sum += held[i] - (i - win >= 0 ? held[i - win] : pre);
    g[i] = Math.min(1, sum / win);
  }
}

function applyGain(channels, gain, g, out) {
  channels.forEach((ch, c) => {
    const o = out[c];
    for (let i = 0; i < ch.length; i++) o[i] = ch[i] * gain * g[i];
  });
}

function limiterStats(g) {
  let max = 0, over1 = 0, sumDb = 0, active = 0;
  for (let i = 0; i < g.length; i++) {
    const r = -20 * Math.log10(g[i]);
    if (r > max) max = r;
    if (r > 1) over1++;
    if (r > 0.1) {
      sumDb += r;
      active++;
    }
  }
  return {
    max_reduction_db: round(max),
    average_reduction_db_while_limiting: round(active ? sumDb / active : 0),
    percent_of_time_over_1db: round((100 * over1) / g.length),
  };
}

/**
 * Raise the mix to `targetLufs` and hold its true peak at `ceilingDb`. The
 * limiter removes some loudness, so the makeup gain is found by iterating.
 */
function limitToTarget(channels, sr, targetLufs, ceilingDb) {
  const ceiling = fromDb(ceilingDb);
  const env = peakEnvelope(channels);
  const startLufs = loudness(channels, sr).integrated;
  if (!Number.isFinite(startLufs)) throw new Error("The mix is silent; there is nothing to master.");

  const n = env.length;
  const buf = { need: new Float32Array(n), held: new Float32Array(n), q: new Int32Array(n), g: new Float32Array(n) };
  const out = channels.map(() => new Float32Array(n));
  // Past about 12 dB of extra gain the limiter is saturated: more gain adds
  // distortion, not loudness. Stop there and report the loudness reached.
  const maxGainDb = targetLufs - startLufs + MAX_EXTRA_GAIN_DB;
  let limitAt = ceiling;
  let gainDb, lufs;
  for (let pass = 0; pass < 3; pass++) {
    gainDb = targetLufs - startLufs;
    let prev = null;
    for (let iter = 0; iter < 12; iter++) {
      limiterGain(env, fromDb(gainDb), limitAt, sr, buf);
      applyGain(channels, fromDb(gainDb), buf.g, out);
      lufs = loudness(out, sr).integrated;
      const miss = targetLufs - lufs;
      if (Math.abs(miss) <= 0.05) break;
      // Secant step: the limiter makes loudness rise slower than gain.
      let slope = 1;
      if (prev && gainDb !== prev.gainDb) slope = Math.min(1, Math.max(0.1, (lufs - prev.lufs) / (gainDb - prev.gainDb)));
      prev = { gainDb, lufs };
      const next = Math.min(maxGainDb, gainDb + miss / slope);
      if (next === gainDb) break; // at the limit; keep this result
      gainDb = next;
    }
    // Changing gain sample by sample moves the peaks between samples a little.
    // If the result overshoots, aim the limiter that much lower and redo.
    const tp = Math.max(...out.map(truePeak));
    if (tp <= ceiling * 1.0001) break;
    limitAt *= (ceiling / tp) * 0.999;
  }
  return { out, g: buf.g, gainDb, startLufs, lufs };
}

// ---------------------------------------------------------------------------
// Start and end

function firstAbove(channels, thr) {
  const n = channels[0].length;
  for (let i = 0; i < n; i++) for (const ch of channels) if (Math.abs(ch[i]) > thr) return i;
  return -1;
}

function lastAbove(channels, thr) {
  for (let i = channels[0].length - 1; i >= 0; i--) for (const ch of channels) if (Math.abs(ch[i]) > thr) return i;
  return -1;
}

function maxAbs(channels, from, to) {
  let m = 0;
  for (const ch of channels) for (let i = Math.max(0, from); i < Math.min(ch.length, to); i++) m = Math.max(m, Math.abs(ch[i]));
  return m;
}

/**
 * Trim silence before the first sound and after the ring-out, then fade the
 * ring-out to silence. The fade never starts before the sound has dropped below
 * -40 dBFS, so it shortens the tail without touching the final notes.
 */
function trimAndFade(channels, sr, { trim, fadeSeconds }) {
  const n = channels[0].length;
  const silence = fromDb(SILENCE_DB);
  let start = 0, end = n;
  if (trim) {
    const first = firstAbove(channels, silence);
    const last = lastAbove(channels, silence);
    if (first >= 0) {
      start = Math.max(0, first - Math.round(0.02 * sr));
      end = Math.min(n, last + Math.round(0.1 * sr));
    }
  }
  const cut = channels.map((ch) => ch.slice(start, end));
  const len = end - start;

  // Fade in across the kept pre-roll, which is all below -60 dBFS, so the file
  // starts from silence. A mix that starts mid-sound gets a 2 ms fade instead.
  let fadeIn = trim ? Math.max(0, firstAbove(cut, silence)) : 0;
  if (fadeIn === 0 && maxAbs(cut, 0, 1) > fromDb(CLICK_DB)) fadeIn = Math.round(0.002 * sr);
  for (const ch of cut) for (let i = 0; i < fadeIn; i++) ch[i] *= i / fadeIn;

  let fade = 0;
  if (fadeSeconds > 0) {
    const ringOutFrom = lastAbove(cut, fromDb(RING_OUT_DB)) + 1;
    // A mix that is still sounding at the very end gets a 10 ms fade, enough
    // to stop a click.
    const fadeFrom = Math.min(Math.max(len - Math.round(fadeSeconds * sr), ringOutFrom, 0), len - Math.round(0.01 * sr));
    fade = len - fadeFrom;
    for (const ch of cut) {
      for (let i = fadeFrom; i < len; i++) {
        const t = (len - 1 - i) / Math.max(1, fade - 1);
        ch[i] *= t * t; // eases out instead of stopping at a corner
      }
    }
  }
  return { channels: cut, trimmedStart: start / sr, trimmedEnd: (n - end) / sr, fadeSeconds: fade / sr };
}

// ---------------------------------------------------------------------------
// Writing

/** Write integer PCM WAV bytes with TPDF dither at the target bit depth. */
function encodeWavPcm({ sampleRate, channels }, bits) {
  const nch = channels.length;
  const frames = channels[0].length;
  const bytes = bits / 8;
  const dataSize = frames * nch * bytes;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(nch, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * nch * bytes, 28);
  buf.writeUInt16LE(nch * bytes, 32);
  buf.writeUInt16LE(bits, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataSize, 40);
  const full = 2 ** (bits - 1);
  let p = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++) {
      const dither = Math.random() - Math.random(); // triangular, +/- 1 LSB
      let q = Math.round(channels[c][i] * full + dither);
      if (q > full - 1) q = full - 1;
      else if (q < -full) q = -full;
      if (bits === 16) buf.writeInt16LE(q, p);
      else {
        buf[p] = q & 0xff;
        buf[p + 1] = (q >> 8) & 0xff;
        buf[p + 2] = (q >> 16) & 0xff;
      }
      p += bytes;
    }
  }
  return buf;
}

const safeName = (s) => String(s).replace(/[^\w .()+-]+/g, "").trim().replace(/\s+/g, " ");

async function freePath(dir, base) {
  for (let n = 1; ; n++) {
    const p = path.join(dir, `${base}${n > 1 ? ` ${n}` : ""}.wav`);
    try {
      await fs.access(p);
    } catch {
      return p;
    }
  }
}

/** The song a bounce belongs to: its folder under Bounces, else its file name. */
function songFor(source, bouncesDir) {
  const parent = path.dirname(path.resolve(source));
  if (path.dirname(parent) === path.resolve(bouncesDir)) return path.basename(parent);
  return path.basename(source, path.extname(source)).replace(/^\d+-/, "");
}

// ---------------------------------------------------------------------------
// master_render

export async function renderMaster(opts, { mastersDir, bouncesDir }) {
  const { source, target_lufs: target } = opts;
  if (!Number.isFinite(target)) throw new Error("target_lufs is required, for example -14.");
  if (target > -5 || target < -30) throw new Error(`target_lufs ${target} is outside -30 to -5 LUFS.`);
  const ceilingDb = opts.ceiling_dbtp ?? defaultCeiling(target);
  if (ceilingDb > 0 || ceilingDb < -6) throw new Error(`ceiling_dbtp ${ceilingDb} is outside -6 to 0 dBTP.`);
  const bits = opts.bit_depth ?? 24;
  if (bits !== 24 && bits !== 16) throw new Error("bit_depth must be 24 or 16.");

  await mustExist(source, "bounce");
  const audio = await loadAudio(source);
  const sr = audio.sampleRate;
  const before = measureAudio(audio, path.basename(source));
  const limited = limitToTarget(audio.channels, sr, target, ceilingDb);
  const shaped = trimAndFade(limited.out, sr, { trim: opts.trim ?? true, fadeSeconds: opts.fade_out_seconds ?? 1 });

  const song = safeName(opts.song || songFor(source, bouncesDir)) || "Song";
  const dir = path.join(mastersDir, song);
  await fs.mkdir(dir, { recursive: true });
  const label = safeName(opts.label || `master ${round(target)} LUFS`);
  const file = await freePath(dir, `${song} (${label})`);
  await fs.writeFile(file, encodeWavPcm({ sampleRate: sr, channels: shaped.channels }, bits));

  const after = await measure(file);
  const stats = limiterStats(limited.g);
  const warnings = [];
  if (stats.max_reduction_db > 6) {
    warnings.push(`The limiter pulls the loudest peaks down by up to ${stats.max_reduction_db} dB. Expect less punch. A lower target would sound more open.`);
  }
  if (before.loudness_range_lu != null && after.loudness_range_lu != null && before.loudness_range_lu - after.loudness_range_lu > 2) {
    warnings.push(`The loudness range fell from ${before.loudness_range_lu} to ${after.loudness_range_lu} LU, so the quiet and loud parts sound closer together than in the mix.`);
  }
  if (before.crest_factor_db - after.crest_factor_db > 4) {
    warnings.push(`Peaks now stand ${round(before.crest_factor_db - after.crest_factor_db)} dB closer to the average level than in the mix. Drums may sound flatter.`);
  }
  if (Math.abs(after.loudness_lufs - target) > 0.5) {
    warnings.push(`The master reached ${after.loudness_lufs} LUFS instead of ${target}. Pushing this mix harder would add distortion, not loudness. Lower the target, or make the mix less peaky first (for example, gentle compression on the drums).`);
  }
  if (after.true_peak_dbtp > ceilingDb + 0.05) warnings.push(`The true peak is ${after.true_peak_dbtp} dBTP, above the ${ceilingDb} dBTP ceiling.`);

  return {
    master: file,
    format: `WAV, ${bits}-bit, ${sr} Hz, dithered`,
    settings: { target_lufs: target, ceiling_dbtp: ceilingDb, gain_db: round(limited.gainDb), trim: opts.trim ?? true, fade_out_seconds: round(shaped.fadeSeconds, 2) },
    limiter: stats,
    trimmed: { start_seconds: round(shaped.trimmedStart, 2), end_seconds: round(shaped.trimmedEnd, 2) },
    mix: pick(before),
    master_measurement: pick(after),
    warnings,
  };
}

const pick = (m) => ({
  seconds: m.seconds,
  loudness_lufs: m.loudness_lufs,
  true_peak_dbtp: m.true_peak_dbtp,
  loudness_range_lu: m.loudness_range_lu,
  crest_factor_db: m.crest_factor_db,
  short_term_max_lufs: m.short_term_max_lufs,
});

// ---------------------------------------------------------------------------
// release_check

const LOSSY = new Set(["aac", "mp3", "opus", "vorbis", "ac-3", "ec-3", "aach", "aacl", "aacp", "mp2", "mp1"]);

/** File container and encoding, read with macOS's afinfo. */
async function fileFormat(file) {
  const { stdout } = await run("/usr/bin/afinfo", [file]);
  const container = /File type ID:\s*(\S+)/.exec(stdout)?.[1] ?? "?";
  const data = /Data format:\s*(.*)/.exec(stdout)?.[1] ?? "";
  const codecMatch = /Hz,\s*([^(]+?)\s*(\(|$)/.exec(data);
  let codec = (codecMatch?.[1] ?? "").trim().toLowerCase().replace(/^\./, "");
  let bits = Number(/(\d+)-bit/.exec(data)?.[1]) || null;
  let float = /float/i.test(data);
  // afinfo names plain PCM either "lpcm ... 24-bit" or "Float32" / "Int16".
  const f = /^(float|int)(\d+)/i.exec(codec);
  if (f) {
    codec = "lpcm";
    bits = Number(f[2]);
    float = f[1].toLowerCase() === "float";
  }
  return { container, codec: codec.split(/\s/)[0], bits, float, channels: Number(/(\d+) ch/.exec(data)?.[1]) || null, sampleRate: Number(/(\d+) Hz/.exec(data)?.[1]) || null };
}

/** Encode to 256 kbps AAC the way a streaming service might, decode, and measure peaks. */
async function afterLossy(file) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mixtools-aac-"));
  try {
    const m4a = path.join(dir, "test.m4a");
    const wav = path.join(dir, "test.wav");
    await run("/usr/bin/afconvert", ["-f", "m4af", "-d", "aac", "-b", "256000", file, m4a]);
    await run("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEF32", m4a, wav]);
    const audio = await loadAudio(wav);
    let overs = 0;
    for (const ch of audio.channels) for (let i = 0; i < ch.length; i++) if (Math.abs(ch[i]) > 1) overs++;
    return { true_peak_dbtp: round(db(Math.max(...audio.channels.map(truePeak)))), over_full_scale_samples: overs };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function mustExist(file, what) {
  try {
    await fs.access(file);
  } catch {
    throw new Error(`No ${what} at ${file}.`);
  }
}

const median = (xs) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
};

export async function releaseCheck(opts, { referencesDir, audioExts }) {
  const file = opts.path;
  await mustExist(file, "file");
  const checks = [];
  const add = (check, status, measured, target, note) => checks.push({ check, status, measured, target, note });

  // Format
  const fmt = await fileFormat(file);
  const formatText = `${fmt.container} ${fmt.codec}${fmt.bits ? ` ${fmt.bits}-bit${fmt.float ? " float" : ""}` : ""}`;
  if (LOSSY.has(fmt.codec)) {
    add("file format", "fail", formatText, "WAV, 24-bit", "This is a compressed (lossy) file. Distributors need the full-quality WAV. Render one with master_render.");
  } else if (fmt.codec === "lpcm" && fmt.float) {
    add("file format", "warn", formatText, "WAV, 24-bit", "Float files can hold levels above full scale, and some distributors reject them. Render a 24-bit WAV with master_render.");
  } else if (fmt.codec === "lpcm" && fmt.container === "WAVE" && fmt.bits === 24) {
    add("file format", "pass", formatText, "WAV, 24-bit", "Full-quality WAV, ready to upload.");
  } else if (fmt.codec === "lpcm" && fmt.container === "WAVE" && fmt.bits === 16) {
    add("file format", "pass", formatText, "WAV, 24-bit", "16-bit WAV is fine when the distributor or a CD asks for it. Otherwise 24-bit keeps more detail.");
  } else {
    add("file format", "warn", formatText, "WAV, 24-bit", "Most distributors want WAV. Render one with master_render.");
  }
  if ([44100, 48000, 88200, 96000].includes(fmt.sampleRate)) {
    add("sample rate", "pass", `${fmt.sampleRate} Hz`, "44100 or 48000 Hz", "A rate distributors accept.");
  } else {
    add("sample rate", "warn", `${fmt.sampleRate} Hz`, "44100 or 48000 Hz", "An unusual rate. Check the distributor accepts it.");
  }
  if (fmt.channels === 2) add("channels", "pass", "stereo", "stereo", "Stereo.");
  else if (fmt.channels === 1) add("channels", "warn", "mono", "stereo", "A mono file. Most distributors expect stereo; a stereo file with both sides the same is the usual fix.");
  else add("channels", "fail", `${fmt.channels} channels`, "stereo", "Streaming releases are stereo.");

  // Level
  const audio = await loadAudio(file);
  const m = measureAudio(audio, path.basename(file));
  const L = m.loudness_lufs;
  const target = opts.target_lufs;
  if (Number.isFinite(target)) {
    const off = round(L - target);
    add("loudness", Math.abs(off) <= 1 ? "pass" : "warn", `${L} LUFS`, `${target} LUFS (agreed target)`,
      Math.abs(off) <= 1 ? "On target." : `${Math.abs(off)} LU ${off > 0 ? "louder" : "quieter"} than the agreed target.`);
  } else if (L > -9) {
    add("loudness", "warn", `${L} LUFS`, "-16 to -9 LUFS", `Louder than streaming needs. Services turn it down by about ${round(L + 14)} dB, and the limiting that made it loud stays.`);
  } else if (L < -16) {
    add("loudness", "warn", `${L} LUFS`, "-16 to -9 LUFS", "Quieter than most services play. Spotify turns it up only partly; YouTube, Tidal, and Amazon leave it quiet.");
  } else {
    add("loudness", "pass", `${L} LUFS`, "-16 to -9 LUFS", "Inside the range that suits streaming.");
  }

  const ceiling = opts.ceiling_dbtp ?? defaultCeiling(L);
  const tp = m.true_peak_dbtp;
  if (tp > 0) add("true peak", "fail", `${tp} dBTP`, `${ceiling} dBTP or lower`, "Peaks go above full scale between samples. Players will distort them.");
  else if (tp > ceiling) add("true peak", "warn", `${tp} dBTP`, `${ceiling} dBTP or lower`, "Close enough to full scale that converting to streaming formats can push peaks over and distort.");
  else add("true peak", "pass", `${tp} dBTP`, `${ceiling} dBTP or lower`, "Leaves room for streaming conversion.");

  const clipped = m.clipped_samples + m.over_full_scale_samples;
  add("clipping", clipped ? "fail" : "pass", `${m.clipped_samples} samples at full scale, ${m.over_full_scale_samples} over`, "none",
    clipped ? "Some samples hit or pass full scale. They sound like crackles." : "No samples at full scale.");

  const lossy = await afterLossy(file);
  add("after streaming encode", lossy.true_peak_dbtp > 0 || lossy.over_full_scale_samples ? "fail" : "pass",
    `${lossy.true_peak_dbtp} dBTP after AAC 256 kbps`, "0 dBTP or lower",
    lossy.true_peak_dbtp > 0 ? "Encoding pushes peaks over full scale, so the streamed version will distort. Lower the ceiling and render again." : "Peaks stay under full scale after encoding.");

  // Start and end
  const sr = audio.sampleRate;
  const n = audio.channels[0].length;
  const first = firstAbove(audio.channels, fromDb(SILENCE_DB));
  const last = lastAbove(audio.channels, fromDb(SILENCE_DB));
  const lead = round(first / sr, 2);
  const tail = round((n - 1 - last) / sr, 2);
  // A click is a jump from silence at the very first or last sample. A song
  // that is still loud in its first or last 50 ms may have been cut off.
  const firstSample = db(maxAbs(audio.channels, 0, 1));
  const lastSample = db(maxAbs(audio.channels, n - 1, n));
  const edge = Math.round(0.05 * sr);
  const startLevel = db(maxAbs(audio.channels, 0, edge));
  const endLevel = db(maxAbs(audio.channels, n - edge, n));
  const cutOffNote = "Check that Ardour's session start and end markers do not cut the song off; bounces cover only the space between them.";
  if (lead > 0.5) add("start", "warn", `${lead} s of silence first`, "under 0.5 s", "Listeners hear a gap before the song. Trim it unless it is intended.");
  else if (firstSample > CLICK_DB) add("start", "warn", `first sample at ${round(firstSample)} dBFS`, "starts from silence", "The file jumps straight in and may click. master_render adds a tiny fade-in.");
  else if (startLevel > CUT_OFF_DB) add("start", "warn", `${round(startLevel)} dBFS in the first 50 ms`, "a clean start", `The song starts at full level. Fine for a hard downbeat. ${cutOffNote}`);
  else add("start", "pass", `${lead} s before the first sound`, "under 0.5 s", "Starts cleanly.");
  if (tail > 2) add("end", "warn", `${tail} s of silence at the end`, "under 2 s", "A long gap after the song. Trim it unless it is intended.");
  else if (lastSample > CLICK_DB) add("end", "warn", `last sample at ${round(lastSample)} dBFS`, "ends in silence", "The file stops mid-sound and may click. master_render fades the end.");
  else if (endLevel > CUT_OFF_DB) add("end", "warn", `${round(endLevel)} dBFS in the last 50 ms`, "a ring-out to silence", `The song stops while still loud. ${cutOffNote}`);
  else add("end", "pass", `${tail} s after the last sound`, "under 2 s", "Ends cleanly.");

  if (m.stereo) {
    add("mono", m.stereo.mono_warning ? "warn" : "pass", `correlation ${m.stereo.correlation}, mono loss ${m.stereo.mono_loss_db} dB`, "correlation above 0",
      m.stereo.mono_warning ? "Parts of the song get quieter or vanish in mono, as on a phone speaker or smart speaker." : "Holds up in mono.");
  }

  // Dynamics against references
  let refs = opts.references;
  if (!refs) {
    try {
      refs = (await fs.readdir(referencesDir)).filter((f) => audioExts.has(path.extname(f).toLowerCase())).map((f) => path.join(referencesDir, f));
    } catch {
      refs = [];
    }
  }
  const refMeasures = [];
  for (const r of refs) {
    try {
      refMeasures.push({ file: r, ...pick(await measure(r)) });
    } catch (e) {
      refMeasures.push({ file: r, error: e.message });
    }
  }
  const ok = refMeasures.filter((r) => !r.error);
  if (ok.length) {
    const lra = median(ok.map((r) => r.loudness_range_lu));
    const crest = median(ok.map((r) => r.crest_factor_db));
    const flatter = m.loudness_range_lu < lra - 3 || m.crest_factor_db < crest - 3;
    add("dynamics vs references", flatter ? "warn" : "pass",
      `range ${m.loudness_range_lu} LU, crest ${m.crest_factor_db} dB`, `references: range ${lra} LU, crest ${crest} dB`,
      flatter ? "Flatter than the references. Once services match levels, this master can sound smaller. A lower loudness target keeps more punch." : "As lively as the references.");
  } else {
    add("dynamics vs references", "skipped", `range ${m.loudness_range_lu} LU, crest ${m.crest_factor_db} dB`, "no references", "Add reference songs to compare punch and loudness range.");
  }

  const spotifyUp = Math.min(-14 - L, -1 - tp);
  const fails = checks.filter((c) => c.status === "fail");
  const warns = checks.filter((c) => c.status === "warn");
  return {
    file,
    ready: fails.length === 0,
    verdict: fails.length
      ? `Not ready: ${fails.map((c) => c.check).join(", ")}.`
      : warns.length
        ? `Ready to upload once the person accepts: ${warns.map((c) => c.check).join(", ")}.`
        : "Ready to upload.",
    checks,
    streaming_playback_change_db: {
      spotify: round(L > -14 ? -14 - L : Math.max(0, spotifyUp)),
      youtube_tidal_amazon: round(Math.min(0, -14 - L)),
      apple_music_approx: round(Math.min(0, -16 - L)),
      note: "Negative numbers mean the service plays the song that much quieter than the file.",
    },
    references: refMeasures,
    measurement: m,
  };
}
