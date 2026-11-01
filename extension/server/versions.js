// Alternate versions of an approved master: instrumental, TV mix, a cappella,
// clean edit, and stems. Each one is rendered from the same mix in Ardour with
// only the needed change, then mastered with the master's exact settings.

import path from "node:path";

import * as ardour from "./ardour.js";
import { db, loadAudio, measure, round } from "./audio.js";
import { guessRole } from "./balance.js";
import { masterSettings, renderVersion } from "./master.js";
import { formatTime, parseTime } from "./moment.js";

export const VERSIONS = ["instrumental", "tv_mix", "a_cappella", "clean", "stems"];
const VERSION_LABEL = { instrumental: "instrumental", tv_mix: "TV mix", a_cappella: "a cappella", clean: "clean" };

const STEM_GROUP_OF_ROLE = {
  kick: "Drums", snare: "Drums", toms: "Drums", cymbals: "Drums", overheads: "Drums", drums: "Drums", percussion: "Drums",
  bass: "Bass",
  lead_vocal: "Lead vocal",
  backing_vocals: "Backing vocals",
  guitar: "Music", keys: "Music", synth: "Music", pad: "Music", strings: "Music", fx: "Music", other: "Music",
};

const CLEAN_FADE_PAD_S = 0.01; // silence a little beyond each stretch so no word edge is left

function byName(all, names, what) {
  return names.map((n) => {
    const t = all.find((x) => x.name.toLowerCase() === String(n).toLowerCase());
    if (!t) throw new Error(`No track named "${n}" for ${what}. Tracks: ${all.map((x) => x.name).join(", ")}.`);
    return t;
  });
}

export async function makeVersions(opts) {
  const wanted = opts.versions?.length ? opts.versions : ["instrumental", "stems"];
  for (const v of wanted) if (!VERSIONS.includes(v)) throw new Error(`Unknown version "${v}". Versions: ${VERSIONS.join(", ")}.`);
  const settings = await masterSettings(opts.master);

  let info;
  try {
    info = await ardour.sessionInfo();
  } catch {
    throw new Error("Ardour is not open with a song. Open the song the master was made from first.");
  }
  const masterSong = path.basename(path.dirname(path.resolve(opts.master)));
  if (masterSong !== info.sessionName) throw new Error(`The master is from "${masterSong}", but Ardour has "${info.sessionName}" open. Open "${masterSong}" first.`);

  const all = (await ardour.tracks()).filter((t) => t.type !== "bus");
  const roleOf = new Map(all.map((t) => [t.id, guessRole(t.name)]));
  const vocals = opts.vocal_tracks ? byName(all, opts.vocal_tracks, "vocal_tracks") : all.filter((t) => ["lead_vocal", "backing_vocals"].includes(roleOf.get(t.id)));
  const lead = opts.lead_tracks ? byName(all, opts.lead_tracks, "lead_tracks") : vocals.filter((t) => roleOf.get(t.id) === "lead_vocal");
  const needsVocals = wanted.some((v) => v !== "stems");
  if (needsVocals && !vocals.length) throw new Error(`No track looks like a vocal. Pass vocal_tracks with the vocal track names. Tracks: ${all.map((t) => t.name).join(", ")}.`);

  // The mix in Ardour must still be the one the master was made from, or the
  // versions would not match the master.
  const check = await ardour.renderVariant("versions check");
  const drift = differenceAudio(await loadAudio(settings.source), await loadAudio(check));
  if (drift > -60) {
    throw new Error(`The mix in Ardour has changed since the master was made (it differs by up to ${round(drift)} dB against its loudest peak). Restore the snapshot the master was made from (usually "final mix"), then try again.`);
  }

  const out = { master: opts.master, versions: [], stems: [], notes: [] };
  const master = async (key, mix) => {
    const r = await renderVersion(opts.master, mix, { label: VERSION_LABEL[key] });
    const m = await measure(r.file);
    out.versions.push({ version: key, file: r.file, loudness_lufs: m.loudness_lufs, true_peak_dbtp: m.true_peak_dbtp, limiter: r.limiter });
  };

  if (wanted.includes("instrumental")) {
    await master("instrumental", await ardour.renderVariant("instrumental", { mute: vocals.map((t) => t.id) }));
  }
  if (wanted.includes("tv_mix")) {
    if (!lead.length) throw new Error("No track looks like the lead vocal. Pass lead_tracks for the TV mix.");
    if (lead.length === vocals.length) out.notes.push("The TV mix keeps the backing vocals, but this song has none, so it is the same as the instrumental.");
    await master("tv_mix", await ardour.renderVariant("tv mix", { mute: lead.map((t) => t.id) }));
  }
  if (wanted.includes("a_cappella")) {
    await master("a_cappella", await ardour.renderVariant("a cappella", { only: vocals.map((t) => t.id) }));
  }
  if (wanted.includes("clean")) {
    const spans = (opts.clean_spans ?? []).map((s) => ({ start: parseTime(s.start), end: parseTime(s.end) }));
    if (!spans.length) throw new Error("A clean edit needs clean_spans: the start and end of each word to silence.");
    for (const s of spans) {
      if (!(s.end > s.start)) throw new Error(`The stretch ${formatTime(s.start)} to ${formatTime(s.end)} ends before it starts.`);
      if (s.end - s.start > 5) throw new Error(`The stretch ${formatTime(s.start)} to ${formatTime(s.end)} is longer than 5 seconds. Silence single words or short phrases.`);
    }
    const start = await ardour.sessionStartSample();
    const sr = settings.sample_rate;
    const silence = [];
    for (const t of vocals) {
      for (const s of spans) {
        silence.push({
          id: t.id,
          start: start + Math.max(0, Math.round((s.start - CLEAN_FADE_PAD_S) * sr)),
          end: start + Math.round((s.end + CLEAN_FADE_PAD_S) * sr),
        });
      }
    }
    await master("clean", await ardour.renderVariant("clean", { silence }));
    out.clean_spans = spans.map((s) => ({ start: formatTime(s.start), end: formatTime(s.end) }));
  }
  if (wanted.includes("stems")) {
    const groups = {};
    if (opts.stem_groups) {
      for (const [g, names] of Object.entries(opts.stem_groups)) groups[g] = byName(all, names, `stem group ${g}`);
    } else {
      for (const t of all) (groups[STEM_GROUP_OF_ROLE[roleOf.get(t.id)]] ??= []).push(t);
    }
    const dir = path.join(path.dirname(path.resolve(opts.master)), `Stems (${settings.label})`);
    const files = [];
    for (const [g, ts] of Object.entries(groups)) {
      const mix = await ardour.renderVariant(`stem ${g}`, { only: ts.map((t) => t.id) });
      files.push(mix);
      const r = await renderVersion(opts.master, mix, { label: g, stem: true, dir });
      out.stems.push({ stem: g, tracks: ts.map((t) => t.name), file: r.file });
    }
    // Stems should add up to the mix. A compressor or limiter on the Master
    // bus stops that, because it reacts to the whole mix.
    const sum = await sumFiles(files);
    const gap = differenceAudio(await loadAudio(settings.source), sum);
    out.stems_add_up_to_mix_within_db = round(gap);
    if (gap > -40) out.notes.push(`The stems add up to the mix only to within ${round(gap)} dB of its peak, usually because of a compressor on the Master bus. Tell whoever receives them.`);
    out.notes.push("Stems are at mix level, before mastering, so they add up to the mix. They are trimmed and faded like the master, so they line up with it.");
  }
  return out;
}

async function sumFiles(files) {
  let sum = null;
  for (const f of files) {
    const { channels, sampleRate } = await loadAudio(f);
    if (!sum) sum = { sampleRate, channels: channels.map((ch) => new Float32Array(ch.length)) };
    channels.forEach((ch, c) => {
      const o = sum.channels[Math.min(c, sum.channels.length - 1)];
      for (let i = 0; i < Math.min(ch.length, o.length); i++) o[i] += ch[i];
    });
  }
  return sum;
}

/** Largest difference between two renders, in dB against the first one's peak. */
function differenceAudio(a, b) {
  let peak = 0, diff = 0;
  const n = Math.min(a.channels[0].length, b.channels[0].length);
  for (let c = 0; c < a.channels.length; c++) {
    const x = a.channels[c], y = b.channels[Math.min(c, b.channels.length - 1)];
    for (let i = 0; i < n; i++) {
      peak = Math.max(peak, Math.abs(x[i]));
      diff = Math.max(diff, Math.abs(x[i] - y[i]));
    }
  }
  return db(diff) - db(peak);
}
