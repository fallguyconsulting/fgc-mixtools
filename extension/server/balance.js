// Starting balance: set first-pass faders on a freshly imported song so no
// track starts buried or clipping, before the person gives any notes.

import * as ardour from "./ardour.js";
import { db, loadAudio, loudness, measure, round, truePeak } from "./audio.js";

/**
 * Starting level of each role while it plays, in dB against the lead vocal
 * (or the lead part). A first pass for the person's ears to correct, not a
 * finished balance.
 */
export const ROLE_LEVELS = {
  lead_vocal: 0,
  drums: -3,
  kick: -5,
  snare: -6,
  bass: -5,
  backing_vocals: -7,
  guitar: -7,
  keys: -7,
  synth: -8,
  overheads: -9,
  toms: -12,
  pad: -11,
  strings: -11,
  percussion: -12,
  cymbals: -14,
  fx: -14,
  other: -8,
};

// First match wins, so the specific patterns come before the general ones.
const ROLE_PATTERNS = [
  ["backing_vocals", /\b(backing|bgv|bvs?|harmon\w*|choir|doubles?|adlibs?|ad libs?|oohs?|aahs?)\b/i],
  ["kick", /\b(kick|bd|bass ?drum)\b/i],
  ["snare", /\b(snare|sn|sd)\b/i],
  ["toms", /\b(toms?|floor tom|rack tom)\b/i],
  ["cymbals", /\b(hi ?hats?|hh|cymbals?|ride|crash|splash|china)\b/i],
  ["overheads", /\b(overheads?|oh|room|rooms|amb(ience)?)\b/i],
  ["drums", /\b(drums?|kit|beat|drum ?loop|loop)\b/i],
  ["bass", /\b(bass|sub|808)\b/i],
  ["guitar", /\b(gtrs?|guitars?|acoustic|electric|strat|tele)\b/i],
  ["keys", /\b(keys|piano|organ|rhodes|wurli\w*|clav\w*|epiano|ep)\b/i],
  ["pad", /\b(pads?|drone|atmos\w*)\b/i],
  ["strings", /\b(strings?|violins?|viola|cello|orch\w*|brass|horns?|sax\w*|trumpets?)\b/i],
  ["synth", /\b(synths?|arp\w*|pluck\w*)\b/i],
  ["percussion", /\b(perc\w*|shakers?|tamb\w*|congas?|bongos?|claps?|snaps?|cowbell)\b/i],
  ["fx", /\b(fx|sfx|risers?|sweeps?|noise|impacts?)\b/i],
  // Last, so "Lead Guitar" and "Lead Synth" are instruments.
  ["lead_vocal", /\b(lead|vox|vocals?|voice|singer)\b/i],
];

export function guessRole(name) {
  const words = String(name).replace(/[_\-.]+/g, " ");
  for (const [role, re] of ROLE_PATTERNS) if (re.test(words)) return role;
  return "other";
}

const PEAK_TARGET_DB = -6;   // mix peaks while mixing, leaving room to raise things
const FADER_MAX_DB = 6;      // Ardour's fader range tops out at +6 dB
const SILENT_LUFS = -70;

/**
 * Count the moments where the recording clips: 3 or more identical samples in
 * a row at the file's own highest level, entered or left with a jump of more
 * than 0.5% of that level. A clipped wave runs steeply into a flat top. A
 * natural peak flattens out gradually, though a 16-bit file can still repeat
 * its top value a few times. The track's fader does not matter. Clips less
 * than 0.1 s apart count as one moment.
 */
export function clippedMoments(channels, sr) {
  let peak = 0;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
  if (peak < 0.05) return 0;
  const lim = peak * 0.999;
  const same = peak * 1e-6;
  const steep = peak * 0.005;
  const starts = [];
  for (const ch of channels) {
    let i = 0;
    while (i < ch.length) {
      if (Math.abs(ch[i]) < lim) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < ch.length && Math.abs(ch[j + 1] - ch[i]) <= same) j++;
      if (j - i + 1 >= 3) {
        const entry = i > 0 ? Math.abs(ch[i] - ch[i - 1]) : 0;
        const exit = j + 1 < ch.length ? Math.abs(ch[j] - ch[j + 1]) : 0;
        if (Math.max(entry, exit) > steep) starts.push(i);
      }
      i = j + 1;
    }
  }
  starts.sort((a, b) => a - b);
  let moments = 0, last = -Infinity;
  for (const s of starts) {
    if (s - last > 0.1 * sr) moments++;
    last = s;
  }
  return moments;
}

async function setFader(id, value) {
  await ardour.call("track_set_fader_db", { id, db: value });
  const got = (await ardour.call("track_get_fader", { id })).db;
  if (Math.abs(got - value) > 0.05) throw new Error(`Ardour set track ${id}'s fader to ${got} dB instead of ${value} dB.`);
}

/** Add gain to every region on a track (clip gain), for tracks too quiet for the fader alone. */
async function addClipGain(id, addDb) {
  const { regions = [] } = await ardour.call("track_get_regions", { id });
  for (const r of regions) {
    const info = await ardour.call("region_get_info", { regionId: r.regionId });
    if (!info.isAudio) continue;
    await ardour.call("region_set_gain_db", { regionId: r.regionId, db: (info.audio?.gainDb ?? 0) + addDb });
  }
  return regions.length;
}

/**
 * Set the starting balance. Bounces every track alone, measures each one's
 * loudness while it plays, sets faders to its role's level against the lead,
 * and moves all faders together so the mix peaks near PEAK_TARGET_DB.
 */
export async function startingBalance(opts = {}) {
  const roles = opts.roles ?? {};
  const levels = opts.levels ?? {};
  for (const [k, v] of Object.entries(roles)) {
    if (!(v in ROLE_LEVELS)) throw new Error(`Unknown role "${v}" for ${k}. Roles: ${Object.keys(ROLE_LEVELS).join(", ")}.`);
  }

  const all = (await ardour.tracks()).filter((t) => t.type !== "bus");
  if (!all.length) throw new Error("The song has no tracks yet.");
  const lower = (s) => s.toLowerCase();
  for (const k of [...Object.keys(roles), ...Object.keys(levels)]) {
    if (!all.some((t) => lower(t.name) === lower(k))) throw new Error(`No track named "${k}". Tracks: ${all.map((t) => t.name).join(", ")}.`);
  }
  const pick = (map, name) => Object.entries(map).find(([k]) => lower(k) === lower(name))?.[1];

  const tracks = [];
  for (const t of all) {
    const info = await ardour.call("track_get_info", { id: t.id });
    tracks.push({ id: t.id, name: t.name, fader0: info.fader?.db ?? 0, muted: !!info.mute });
  }
  const moved = tracks.filter((t) => Math.abs(t.fader0) > 0.05);
  if (moved.length && !opts.replace_current_levels) {
    throw new Error(
      `These faders have already been moved: ${moved.map((t) => `${t.name} ${round(t.fader0)} dB`).join(", ")}. A starting balance replaces them. Pass replace_current_levels: true only if the person wants to start the balance over.`,
    );
  }

  const before = await ardour.snapshotSave("before starting balance");
  const raw = await ardour.bounce("raw levels", tracks.filter((t) => !t.muted).map((t) => t.name));

  // Measure each track alone, at its current fader.
  for (const t of tracks) {
    t.role = pick(roles, t.name) ?? guessRole(t.name);
    t.offset = pick(levels, t.name) ?? ROLE_LEVELS[t.role];
    const stem = raw.stems.find((s) => s.track === t.name);
    if (!stem) {
      t.skip = "muted";
      continue;
    }
    const audio = await loadAudio(stem.file);
    t.file = stem.file;
    t.lufs = loudness(audio.channels, audio.sampleRate).integrated;
    t.clips = clippedMoments(audio.channels, audio.sampleRate);
    if (!Number.isFinite(t.lufs) || t.lufs < SILENT_LUFS) t.skip = "silent";
  }
  const live = tracks.filter((t) => !t.skip);
  if (!live.length) throw new Error("Every track is muted or silent, so there is nothing to balance.");

  // Fader for each track, relative for now: its role's level minus how loud it is.
  for (const t of live) t.fader = t.fader0 + t.offset - t.lufs;
  const shift0 = -Math.max(...live.map((t) => t.fader));
  for (const t of live) t.fader += shift0;

  // Predict the mix from the solo bounces at the new faders, one track at a
  // time to keep memory low. Solo bounces add up to the mix when nothing on the
  // Master bus changes the sound with level.
  let mix = null;
  for (const t of live) {
    const { channels } = await loadAudio(t.file);
    if (!mix) mix = [new Float32Array(channels[0].length), new Float32Array(channels[0].length)];
    const g = Math.pow(10, (t.fader - t.fader0) / 20);
    for (let c = 0; c < mix.length; c++) {
      const src = channels[Math.min(c, channels.length - 1)];
      const out = mix[c];
      for (let i = 0; i < Math.min(src.length, out.length); i++) out[i] += src[i] * g;
    }
  }
  const predictedPeak = db(Math.max(...mix.map(truePeak)));
  mix = null;
  const shift1 = PEAK_TARGET_DB - predictedPeak;
  for (const t of live) t.fader += shift1;

  // Apply. Past the fader's +6 dB, the rest goes on the clips.
  async function apply() {
    for (const t of live) {
      t.clipGain = t.clipGain ?? 0;
      if (t.fader > FADER_MAX_DB) {
        const extra = t.fader - FADER_MAX_DB;
        await addClipGain(t.id, extra);
        t.clipGain += extra;
        t.fader = FADER_MAX_DB;
      }
      await setFader(t.id, round(t.fader, 2));
    }
  }
  await apply();

  // Check with a real bounce, and correct once if the Master bus changed things.
  let result = await ardour.bounce("starting balance");
  let m = await measure(result.mix);
  if (Math.abs(m.true_peak_dbtp - PEAK_TARGET_DB) > 1) {
    const fix = PEAK_TARGET_DB - m.true_peak_dbtp;
    for (const t of live) t.fader += fix;
    await apply();
    result = await ardour.bounce("starting balance");
    m = await measure(result.mix);
  }
  const after = await ardour.snapshotSave("starting balance");

  const lead = live.find((t) => t.role === "lead_vocal") ?? null;
  const notes = [];
  if (!lead) notes.push("No track looks like a lead vocal. The tracks are still set against each other by role. If one track is the lead part, pass its role as lead_vocal in 'roles' and run again with replace_current_levels: true.");
  for (const t of tracks) {
    if (t.skip === "muted") notes.push(`${t.name} is muted, so it was left alone.`);
    if (t.skip === "silent") notes.push(`${t.name} is silent, so it was left alone.`);
    if (t.role === "other" && !t.skip) notes.push(`${t.name}: the name does not say what it is, so it got a middle level. Ask the person what it is, then pass its role in 'roles'.`);
    if (t.clips) notes.push(`${t.name}: the recording itself clips at ${t.clips} moment${t.clips === 1 ? "" : "s"}. Turning it down cannot remove that distortion; only a new recording can.`);
    if (t.clipGain > 0.05) notes.push(`${t.name} was recorded very quietly. Its fader is at the top (+6 dB), and its clips are turned up ${round(t.clipGain)} dB more.`);
  }
  if (m.over_full_scale_samples > 0) notes.push("The balanced mix still goes over full scale somewhere. Check the Master bus for plugins that add level.");

  return {
    snapshots: { before: before.id, after: after.id },
    bounces: { raw_levels: raw.mix, starting_balance: result.mix },
    tracks: tracks.map((t) => ({
      track: t.name,
      role: t.role,
      level_vs_lead_db: t.skip ? null : t.offset,
      raw_level_lufs: t.skip ? null : round(t.lufs),
      fader_db_before: round(t.fader0),
      fader_db: t.skip ? round(t.fader0) : round(t.fader),
      clip_gain_added_db: t.skip ? 0 : round(t.clipGain),
      recording_clipped_moments: t.clips ?? 0,
      ...(t.skip ? { left_alone: t.skip } : {}),
    })),
    mix: { true_peak_dbtp: m.true_peak_dbtp, sample_peak_dbfs: m.sample_peak_dbfs, loudness_lufs: m.loudness_lufs },
    notes,
  };
}
