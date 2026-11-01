// Timestamp notes: the person says "at 1:23 the vocal disappears". Measure that
// moment of a bounce and its stems against the rest of the song, so the change
// can be made at that moment only.

import { promises as fs } from "node:fs";
import path from "node:path";

import { BAND_WORDS, BANDS, bandLevels, db, loadAudio, loudnessMeter, round, truePeak } from "./audio.js";

const SHORT_S = 3;      // loudness window, as in short-term loudness
const HOP_S = 0.5;      // step between song windows
const GAP_S = 0.25;     // shortest silence that counts as a gap between phrases
const GAP_SEARCH_S = 15;
const FRAME_S = 0.01;
const NOTABLE_DB = 3;
const NOTABLE_TONE_DB = 4; // a song's tone changes from section to section anyway

/** Seconds from 83, "83", "1:23", "1:23.5", or "0:01:23". */
export function parseTime(t) {
  if (typeof t === "number" && Number.isFinite(t) && t >= 0) return t;
  const s = String(t ?? "").trim();
  let m;
  if ((m = s.match(/^(\d+(?:\.\d+)?)$/))) return Number(m[1]);
  if ((m = s.match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/))) return Number(m[1]) * 60 + Number(m[2]);
  if ((m = s.match(/^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/))) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  throw new Error(`"${t}" is not a time. Give seconds (83) or minutes:seconds ("1:23").`);
}

/** "1:23", or "1:23.5" when the time is not a whole second. */
export function formatTime(seconds) {
  const tenths = Math.round(seconds * 10);
  const whole = Math.floor(tenths / 10);
  const frac = tenths % 10;
  const ss = String(whole % 60).padStart(2, "0");
  return `${Math.floor(whole / 60)}:${ss}${frac ? `.${frac}` : ""}`;
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const powerMean = (lufs) => {
  const p = lufs.reduce((sum, l) => sum + Math.pow(10, (l + 0.691) / 10), 0) / lufs.length;
  return -0.691 + 10 * Math.log10(p);
};

/** Window starts covering the song, every HOP_S seconds. */
function windowStarts(seconds) {
  const out = [];
  for (let s = 0; s + SHORT_S <= seconds + 1e-9; s += HOP_S) out.push(s);
  return out.length ? out : [0];
}

/** Which windows count as "playing": above -70 LUFS and within 20 dB of the stem's own average. */
function activeMask(levels) {
  const abs = levels.filter((l) => l > -70);
  if (!abs.length) return levels.map(() => false);
  const gate = powerMean(abs) - 20;
  return levels.map((l) => l > -70 && l > gate);
}

/**
 * Silent gaps of at least GAP_S seconds, as [start, end] in seconds. Silence
 * is RMS more than 30 dB below the stem's typical level (and below -40 dBFS).
 */
function silentGaps(channels, sr, typicalLufs) {
  const frame = Math.round(FRAME_S * sr);
  const thr = Math.pow(10, Math.min(-40, (typicalLufs ?? -20) - 30) / 20);
  const n = Math.floor(channels[0].length / frame);
  const gaps = [];
  let runStart = null;
  for (let f = 0; f <= n; f++) {
    let quiet = false;
    if (f < n) {
      let sum = 0;
      for (const ch of channels) for (let i = f * frame; i < (f + 1) * frame; i++) sum += ch[i] * ch[i];
      quiet = Math.sqrt(sum / (frame * channels.length)) < thr;
    }
    if (quiet && runStart == null) runStart = f;
    if (!quiet && runStart != null) {
      if ((f - runStart) * FRAME_S >= GAP_S) gaps.push([runStart * FRAME_S, f * FRAME_S]);
      runStart = null;
    }
  }
  return gaps;
}

/**
 * The phrase around time t: from the middle of the last silent gap that starts
 * at or before t to the middle of the next one. A time inside a gap gives the
 * phrase after it. Splitting a region there changes no sound mid-note.
 */
function passageAround(gaps, t, seconds) {
  // Split in the middle of a short gap, or a little way into a long one, so
  // the phrase ends close to the sound.
  const reach = GAP_S;
  const before = gaps.filter(([s]) => s <= t).at(-1);
  const after = gaps.find(([s]) => s > t);
  // With no gap at all on one side, the phrase runs to the start or end of the song.
  let start = before ? Math.max((before[0] + before[1]) / 2, before[1] - reach) : 0;
  let end = after ? Math.min((after[0] + after[1]) / 2, after[0] + reach) : seconds;
  if (t - start > GAP_SEARCH_S) start = null;
  if (end - t > GAP_SEARCH_S) end = null;
  return { start: start == null ? null : round(start, 2), end: end == null ? null : round(end, 2) };
}

/** The stems bounced with this mix: "<bounce>-stem-<track>.wav" beside it. */
async function stemsFor(file) {
  const base = path.basename(file, path.extname(file));
  if (base.includes("-stem-")) return [];
  const dir = path.dirname(file);
  let names = [];
  try {
    names = await fs.readdir(dir);
  } catch {}
  return names.filter((n) => n.startsWith(`${base}-stem-`) && n.endsWith(".wav")).sort().map((n) => path.join(dir, n));
}

const trackName = (file) => {
  const base = path.basename(file, path.extname(file));
  const i = base.indexOf("-stem-");
  return i >= 0 ? base.slice(i + 6).replace(/-/g, " ") : base;
};

const louder = (v) => (v > 0 ? "louder" : "quieter");

/**
 * Measure one moment of a mix bounce and its stems against the whole song.
 * `toSample` maps song seconds to Ardour's timeline, when the bounce belongs to
 * the open song.
 */
export async function momentCheck(file, opts = {}, toSample = null) {
  const t = parseTime(opts.time);
  const w = opts.window_seconds ?? SHORT_S;
  const mix = await loadAudio(file);
  const sr = mix.sampleRate;
  const seconds = mix.channels[0].length / sr;
  if (t > seconds) throw new Error(`${formatTime(t)} is past the end of ${path.basename(file)} (${formatTime(seconds)} long).`);
  const b = Math.min(seconds, Math.max(t + w / 2, w));
  const a = Math.max(0, b - w);

  const starts = windowStarts(seconds);
  const mixMeter = loudnessMeter(mix.channels, sr);
  const mixLevels = starts.map((s) => mixMeter.between(s, s + SHORT_S));
  const mixActive = activeMask(mixLevels);
  const mixNow = mixMeter.between(a, b);
  const mixTypical = median(mixLevels.filter((_, i) => mixActive[i]));

  const findings = [];
  const mixChange = mixNow - mixTypical;
  if (Math.abs(mixChange) >= NOTABLE_DB) {
    findings.push({ size: Math.abs(mixChange), text: `The whole mix is ${round(Math.abs(mixChange))} dB ${louder(mixChange)} here than it usually is.` });
  }

  const stemFiles = opts.stems ?? (await stemsFor(file));
  const tracks = [];
  for (const stemFile of stemFiles) {
    const stem = await loadAudio(stemFile);
    if (stem.sampleRate !== sr) throw new Error(`${path.basename(stemFile)} has a different sample rate from the mix.`);
    const name = trackName(stemFile);
    const meter = loudnessMeter(stem.channels, sr);
    const levels = starts.map((s) => meter.between(s, s + SHORT_S));
    const active = activeMask(levels);
    const typical = median(levels.filter((_, i) => active[i]));
    const now = meter.between(a, b);

    // The rest of the mix: the mix with this track taken out. A track that
    // makes up most of the mix would otherwise hide its own drop.
    const len = Math.min(mix.channels[0].length, stem.channels[0].length);
    const rest = mix.channels.map((ch, c) => {
      const s = stem.channels[Math.min(c, stem.channels.length - 1)];
      const r = new Float32Array(len);
      for (let i = 0; i < len; i++) r[i] = ch[i] - s[i];
      return r;
    });
    const restMeter = loudnessMeter(rest, sr);
    const restLevels = starts.map((s) => restMeter.between(s, s + SHORT_S));
    const restNow = restMeter.between(a, b);
    const restActive = activeMask(restLevels);
    const usualAgainstRest = median(levels.map((l, i) => l - restLevels[i]).filter((_, i) => active[i] && restActive[i]));
    const playing = typical != null && now > -70 && now > typical - 20;
    const againstNow = Number.isFinite(restNow) && restNow > -70 ? now - restNow : null;
    const change = playing && againstNow != null && usualAgainstRest != null ? againstNow - usualAgainstRest : null;
    const vsOwn = playing ? now - typical : null;

    if (typical != null && !playing) findings.push({ size: 10, text: `The ${name} is silent or nearly silent here.` });
    if (change != null && Math.abs(change) >= NOTABLE_DB) {
      findings.push({ size: Math.abs(change) + 1, text: `The ${name} sits ${round(Math.abs(change))} dB ${change > 0 ? "higher" : "lower"} against the rest of the mix here than it usually does.` });
    } else if (vsOwn != null && Math.abs(vsOwn) >= NOTABLE_DB) {
      findings.push({ size: Math.abs(vsOwn), text: `The ${name} is ${round(Math.abs(vsOwn))} dB ${louder(vsOwn)} here than it usually is.` });
    }

    const passage = passageAround(silentGaps(stem.channels, stem.sampleRate, typical), t, stem.channels[0].length / stem.sampleRate);
    tracks.push({
      track: name,
      file: stemFile,
      playing,
      level_now_lufs: round(now),
      typical_level_lufs: round(typical),
      change_from_typical_db: round(vsOwn),
      against_rest_now_db: playing ? round(againstNow) : null,
      against_rest_usually_db: round(usualAgainstRest),
      change_against_rest_db: round(change),
      phrase: {
        ...passage,
        ...(toSample && passage.start != null ? { start_sample: toSample(passage.start) } : {}),
        ...(toSample && passage.end != null ? { end_sample: toSample(passage.end) } : {}),
      },
    });
  }
  if (!stemFiles.length) {
    findings.push({
      size: 0,
      text: path.basename(file).includes("-stem-")
        ? "This file is a stem. Check the mix bounce it came with to compare the tracks."
        : "No stems came with this bounce, so this cannot say which track changes here. Bounce with stems of the tracks involved and check again.",
    });
  }

  // Tone at this moment against the whole song.
  const lo = Math.floor(a * sr), hi = Math.ceil(b * sr);
  const slice = mix.channels.map((ch) => ch.subarray(lo, hi));
  const bandsNow = bandLevels(slice, sr).levels;
  const bandsSong = bandLevels(mix.channels, sr).levels;
  const tone = {};
  for (const band of BANDS) {
    const d = round(bandsNow[band.name] - bandsSong[band.name]);
    tone[band.name] = d;
    if (Math.abs(d) >= NOTABLE_TONE_DB) findings.push({ size: Math.abs(d) / 2, text: `The mix has ${Math.abs(d)} dB ${d > 0 ? "more" : "less"} ${BAND_WORDS[band.name]} here than across the whole song, relative to its level.` });
  }

  const tp = db(Math.max(...slice.map(truePeak)));
  let clipped = 0;
  for (const ch of slice) for (let i = 0; i < ch.length; i++) if (Math.abs(ch[i]) >= 0.9999) clipped++;
  if (tp > 0) findings.push({ size: 99, text: `The true peak here is ${round(tp)} dBTP, above 0. It may distort.` });
  if (clipped) findings.push({ size: 98, text: `${clipped} samples clip here.` });

  findings.sort((x, y) => y.size - x.size);
  return {
    file: path.basename(file),
    time: formatTime(t),
    seconds: round(t, 2),
    measured: { start: round(a, 2), end: round(b, 2) },
    mix: { level_now_lufs: round(mixNow), typical_level_lufs: round(mixTypical), change_from_typical_db: round(mixChange) },
    tracks,
    tone_vs_whole_song_db: tone,
    true_peak_dbtp: round(tp),
    clipped_samples: clipped,
    findings: findings.map((f) => f.text),
    play_window: { start: round(Math.max(0, t - 4), 1), end: round(Math.min(seconds, t + 3), 1) },
    ...(toSample ? { ardour_sample: toSample(t) } : {}),
  };
}
