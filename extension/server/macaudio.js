// Things outside Ardour that stop its audio engine: another audio app holding
// the Mac's audio, and macOS refusing Ardour the microphone. Either one can
// make Ardour say "failed to start process thread" or freeze mid-session.

import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const ARDOUR_BUNDLE_ID = "org.ardour.Ardour9";
const TCC_DB = path.join(os.homedir(), "Library/Application Support/com.apple.TCC/TCC.db");

// Apps that open the Mac's audio device for recording or playback. A name
// matches the app's name or the start of it ("Ableton Live 12 Suite").
const AUDIO_APPS = [
  "Logic Pro", "GarageBand", "MainStage", "Ableton Live", "Pro Tools", "Cubase", "Nuendo", "REAPER", "FL Studio",
  "Studio One", "Bitwig Studio", "Reason", "Audacity", "Digital Performer", "LUNA", "Final Cut Pro", "Audio Hijack",
];

/** Names of audio apps that are running now, other than Ardour. */
export async function otherAudioApps() {
  let out;
  try {
    out = (await run("/bin/ps", ["-axo", "comm"])).stdout;
  } catch {
    return [];
  }
  const names = new Set();
  for (const line of out.split("\n")) {
    const m = line.match(/\/([^/]+)\.app\/Contents\/MacOS\//);
    if (m) names.add(m[1]);
  }
  return [...names].filter((n) => AUDIO_APPS.some((a) => n === a || n.startsWith(`${a} `))).sort();
}

/**
 * Whether macOS lets Ardour use the microphone: "allowed", "denied",
 * "not asked" (macOS asks the first time Ardour opens the microphone), or
 * "unknown" when macOS does not let mixtools read its privacy settings.
 */
export async function microphoneAccess() {
  let out;
  try {
    out = (await run("/usr/bin/sqlite3", [TCC_DB, `select auth_value from access where service='kTCCServiceMicrophone' and client='${ARDOUR_BUNDLE_ID}'`])).stdout.trim();
  } catch {
    return "unknown";
  }
  if (out === "") return "not asked";
  return out.split("\n").includes("2") ? "allowed" : "denied";
}
