// Vocal "s" sounds: find them, and predict exactly what the Mixtools De-Esser
// (extension/ardour/mixtools-deesser.lua) will do to them at given settings.
// The filter, detector, and gain law here match the plugin's.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadAudio, round } from "./audio.js";

export const DEESSER_NAME = "Mixtools De-Esser";
export const DEESSER_SOURCE = new URL("../ardour/mixtools-deesser.lua", import.meta.url);
export const ARDOUR_SCRIPTS = path.join(os.homedir(), "Library/Preferences/Ardour9/scripts");
export const DEESSER_INSTALLED = path.join(ARDOUR_SCRIPTS, "mixtools-deesser.lua");

const ATTACK_S = 0.0005;
const RELEASE_S = 0.06;
const SLOPE = 0.75;
const DEFAULTS = { frequency: 5500, max_reduction_db: 4 };

// An "s" sound: the part above the split is within 3 dB of the whole sound,
// and louder than -50 dBFS. Vowels keep most of their energy below the split.
const S_SHARE = Math.pow(10, -3 / 20);
const S_FLOOR = Math.pow(10, -50 / 20);
const MERGE_S = 0.03;
const MIN_S = 0.015;
const TOUCHED_DB = 0.5;

// ---------------------------------------------------------------------------
// Install

/** Ardour names a Lua plugin "lua:" plus the SHA-1 of the script file. */
export const pluginId = (text) => `lua:${createHash("sha1").update(text).digest("hex")}`;

export async function deesserStatus() {
  const source = await fs.readFile(DEESSER_SOURCE, "utf8");
  let installed = null;
  try {
    installed = await fs.readFile(DEESSER_INSTALLED, "utf8");
  } catch {}
  return { installed: installed != null, current: installed === source, plugin_id: pluginId(source), file: DEESSER_INSTALLED };
}

export async function installDeesser() {
  const st = await deesserStatus();
  if (st.current) return { changed: false, reason: "already installed", plugin_id: st.plugin_id };
  await fs.mkdir(ARDOUR_SCRIPTS, { recursive: true });
  await fs.copyFile(DEESSER_SOURCE, DEESSER_INSTALLED);
  return { changed: true, plugin_id: st.plugin_id, note: "Ardour loads plugins when it starts. If Ardour is open, save and reopen it before adding the de-esser." };
}

// ---------------------------------------------------------------------------
// Analysis

/** Ardour's Biquad low-pass (RBJ cookbook), run in single precision like Ardour. */
function lowPass(x, sr, freq) {
  const w0 = (2 * Math.PI * freq) / sr;
  const cos = Math.cos(w0), alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const a0 = 1 + alpha;
  const b0 = (1 - cos) / 2 / a0, b1 = (1 - cos) / a0, b2 = b0;
  const a1 = (-2 * cos) / a0, a2 = (1 - alpha) / a0;
  const y = new Float32Array(x.length);
  let z1 = 0, z2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xn = x[i];
    const z = b0 * xn + z1;
    z1 = b1 * xn - a1 * z + z2;
    z2 = b2 * xn - a2 * z;
    y[i] = z;
  }
  return y;
}

const toDb = (v) => 20 * Math.log10(Math.max(v, 1e-12));

/**
 * Find the "s" sounds in a vocal and predict what the de-esser does to each at
 * the given settings. Without threshold_db, suggests one that touches only the
 * loudest quarter of them.
 */
export async function sibilance(file, opts = {}) {
  const frequency = opts.frequency ?? DEFAULTS.frequency;
  const range = opts.max_reduction_db ?? DEFAULTS.max_reduction_db;
  const audio = await loadAudio(file, { start: opts.start, end: opts.end });
  const sr = audio.sampleRate;
  const chs = audio.channels;
  const n = chs[0].length;
  const offset = opts.start ?? 0;
  const lows = chs.map((ch) => lowPass(ch, sr, frequency));

  // Detector envelope of the high part (as in the plugin), and the same
  // envelope of the whole sound, to tell "s" sounds from bright vowels.
  const att = 1 - Math.exp(-1 / (ATTACK_S * sr));
  const rel = 1 - Math.exp(-1 / (RELEASE_S * sr));
  const env = new Float32Array(n);
  const isS = new Uint8Array(n);
  let e = 0, f = 0;
  for (let i = 0; i < n; i++) {
    let det = 0, full = 0;
    for (let c = 0; c < chs.length; c++) {
      const h = Math.abs(chs[c][i] - lows[c][i]);
      if (h > det) det = h;
      const v = Math.abs(chs[c][i]);
      if (v > full) full = v;
    }
    e += (det > e ? att : rel) * (det - e);
    f += (full > f ? att : rel) * (full - f);
    env[i] = e;
    isS[i] = e > S_FLOOR && e >= f * S_SHARE ? 1 : 0;
  }

  // Group "s" samples into events.
  const merge = Math.round(MERGE_S * sr);
  const events = [];
  for (let i = 0; i < n; i++) {
    if (!isS[i]) continue;
    const last = events.at(-1);
    if (last && i - last.to <= merge) last.to = i;
    else events.push({ from: i, to: i });
  }
  const sEvents = events.filter((ev) => ev.to - ev.from >= MIN_S * sr);
  for (const ev of sEvents) {
    let peak = 0;
    for (let i = ev.from; i <= ev.to; i++) if (env[i] > peak) peak = env[i];
    ev.peakDb = toDb(peak);
  }

  const peaks = sEvents.map((ev) => ev.peakDb).sort((a, b) => a - b);
  const suggested = peaks.length ? Math.round(peaks[Math.floor(0.75 * (peaks.length - 1))]) : null;
  const thresholdDb = opts.threshold_db ?? suggested ?? -24;
  const thr = Math.pow(10, thresholdDb / 20);

  // What the plugin does at these settings, sample by sample.
  const reduction = (v) => (v > thr ? Math.min(range, SLOPE * 20 * Math.log10(v / thr)) : 0);
  const inS = new Uint8Array(n);
  const pad = Math.round(0.02 * sr);
  for (const ev of sEvents) {
    ev.reductionDb = 0;
    for (let i = ev.from; i <= ev.to; i++) ev.reductionDb = Math.max(ev.reductionDb, reduction(env[i]));
    for (let i = Math.max(0, ev.from - pad); i <= Math.min(n - 1, ev.to + pad); i++) inS[i] = 1;
  }
  let outside = 0, outsideMax = 0, firstOutside = null;
  for (let i = 0; i < n; i++) {
    if (inS[i]) continue;
    const r = reduction(env[i]);
    if (r >= TOUCHED_DB) {
      outside++;
      if (r > outsideMax) outsideMax = r;
      if (firstOutside == null) firstOutside = i;
    }
  }

  const t = (i) => round(offset + i / sr, 2);
  const describe = (ev) => ({ time: t(ev.from), seconds: round((ev.to - ev.from) / sr, 2), peak_db: round(ev.peakDb), reduction_db: round(ev.reductionDb) });
  const touched = sEvents.filter((ev) => ev.reductionDb >= TOUCHED_DB);
  const loudest = [...sEvents].sort((a, b) => b.peakDb - a.peakDb);

  // Listening windows around the three most-reduced "s" sounds, 3 s each.
  const windows = [];
  for (const ev of [...touched].sort((a, b) => b.reductionDb - a.reductionDb)) {
    const mid = offset + (ev.from + ev.to) / 2 / sr;
    if (windows.some((w) => mid >= w.start && mid <= w.end)) continue;
    const start = Math.max(offset, mid - 1.5);
    windows.push({ start: round(start, 2), end: round(Math.min(offset + n / sr, start + 3), 2) });
    if (windows.length === 3) break;
  }

  const notes = [];
  if (!sEvents.length) notes.push("No clear \"s\" sounds found. This may not be a vocal, or the split frequency may be too high.");
  if (outside / sr >= 0.05) {
    notes.push(`At these settings the de-esser would also turn down ${round(outside / sr, 1)} s of sound that is not an "s" (first at ${t(firstOutside)} s, up to ${round(outsideMax)} dB). That can dull the voice. Raise the threshold or the frequency.`);
  }

  return {
    file: path.basename(file),
    settings: {
      frequency_hz: frequency,
      threshold_db: thresholdDb,
      max_reduction_db: range,
      threshold_is_suggested: opts.threshold_db == null && suggested != null,
    },
    plugin_parameters: { Frequency: frequency, Threshold: thresholdDb, "Max reduction": range },
    s_sounds_found: sEvents.length,
    s_sounds_touched: touched.length,
    touched_outside_s_sounds_seconds: round(outside / sr, 2),
    suggested_threshold_db: suggested,
    loudest_s_sounds: loudest.slice(0, 10).map(describe),
    touched_s_sounds: touched.slice(0, 40).map(describe),
    listening_windows: windows,
    notes,
  };
}
