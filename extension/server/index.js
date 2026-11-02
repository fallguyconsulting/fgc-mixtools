#!/usr/bin/env node
// Mixtools MCP server: lets Claude mix a song in Ardour for someone who is not
// an audio engineer. Speaks MCP over stdio with no dependencies.

import { spawn } from "node:child_process";
import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import * as ardour from "./ardour.js";
import { compare, encodeWavFloat, loadAudio, measure } from "./audio.js";
import * as journal from "./journal.js";
import { releaseCheck, renderMaster } from "./master.js";
import { deesserStatus, installDeesser, sibilance } from "./vocal.js";
import { archiveSong, BOUNCE_CHOICES } from "./archive.js";
import { ROLE_LEVELS, startingBalance } from "./balance.js";
import { makeVersions, VERSIONS } from "./versions.js";
import { formatTime, momentCheck, parseTime } from "./moment.js";
import { preparePlayback, SIMULATIONS } from "./playback.js";
import { STREAMING_SERVICES } from "./master.js";
import { SPECTROGRAM_GRID_HZ, spectrogram } from "./spectrogram.js";
import { selftestSong, SELFTEST_SONG } from "./selftest.js";
import * as feedback from "./feedback.js";
import * as jobs from "./jobs.js";
import { microphoneAccess, otherAudioApps } from "./macaudio.js";
import * as parts from "./parts.js";

const VERSION = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8")).version;
const AUDIO_EXTS = new Set([".wav", ".aif", ".aiff", ".mp3", ".m4a", ".aac", ".flac", ".caf", ".ogg"]);

// ---------------------------------------------------------------------------
// Tool definitions

const range = {
  start: { type: "number", minimum: 0, description: "Start time in seconds. Default: beginning." },
  end: { type: "number", minimum: 0, description: "End time in seconds. Default: end of file." },
};

const TOOLS = [
  {
    name: "mixtools_status",
    description:
      "Check everything mixtools needs: Ardour installed, Ardour open, Ardour's MCP server reachable, the open song, and the workspace folders. Returns a list of problems, each with its fix. Call this first in every session.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "mixtools_setup",
    description:
      "Create the workspace folders (~/Music/Mixtools: Songs, References, Bounces, Masters), install the Mixtools De-Esser plugin for Ardour, and turn on Ardour's MCP server in Ardour's settings. Turning the server on only works while Ardour is closed, and Ardour finds a newly installed plugin only when it next starts. Safe to run again.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "song_new",
    description:
      "Start a new song: create an Ardour session in ~/Music/Mixtools/Songs, open it in Ardour, and import audio files as tracks (one track per file). Ardour must be closed first. Takes up to a few minutes for long files.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Song name, used for the session folder." },
        files: { type: "array", items: { type: "string" }, description: "Absolute paths of audio files to import, one track each." },
        track_names: { type: "array", items: { type: "string" }, description: "Optional track names, matched to files by position." },
      },
      required: ["name", "files"],
      additionalProperties: false,
    },
  },
  {
    name: "song_open",
    description: "Open a song in Ardour. With no path, list the songs in ~/Music/Mixtools/Songs instead. Ardour must be closed or already showing that song.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Song folder or .ardour file." } },
      additionalProperties: false,
    },
  },
  {
    name: "ardour_tools",
    description:
      "List Ardour's own MCP tools (tracks, faders, pan, sends, plugins, transport, markers, regions, undo). With 'name', return that tool's full input schema. Use with ardour_call.",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Only tools whose name contains this text, for example 'plugin' or 'send'." },
        name: { type: "string", description: "Return the full schema of this one tool." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ardour_call",
    description:
      "Call one of Ardour's MCP tools by name, for example track_set_fader_db, track_set_pan, plugin_add, plugin_set_parameter, track_add_send, transport_play. Read its schema with ardour_tools first.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        arguments: { type: "object", description: "Arguments for the Ardour tool." },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "mix_starting_balance",
    description:
      "Set first-pass faders on a freshly imported song so no track starts buried or clipping, before the person gives notes. Saves a snapshot, bounces every track alone, measures how loud each plays, guesses each track's role from its name (lead vocal, drums, bass, guitar, pad, and so on), sets each fader to its role's starting level against the lead, and moves all faders together so the mix peaks near -6 dBFS. A track too quiet for the fader's +6 dB gets the rest as clip gain. Bounces 'raw levels' before and 'starting balance' after. Refuses if faders were already moved, unless replace_current_levels is true.",
    inputSchema: {
      type: "object",
      properties: {
        roles: {
          type: "object",
          additionalProperties: { type: "string", enum: Object.keys(ROLE_LEVELS) },
          description: `Role per track name, for tracks whose names do not say what they are, for example {"Audio 3": "guitar"}. Roles: ${Object.keys(ROLE_LEVELS).join(", ")}.`,
        },
        levels: {
          type: "object",
          additionalProperties: { type: "number", minimum: -30, maximum: 6 },
          description: "Starting level per track name in dB against the lead, overriding its role's level, for example {\"Piano\": -3} when the piano carries the song.",
        },
        replace_current_levels: { type: "boolean", description: "Replace faders that were already moved. Only when the person wants to start the balance over." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "snapshot_save",
    description: "Save the current mixer settings (faders, pans, mutes, plugin settings) as a snapshot so they can be restored. Call before every change.",
    inputSchema: { type: "object", properties: { label: { type: "string" } }, required: ["label"], additionalProperties: false },
  },
  {
    name: "snapshot_list",
    description: "List this song's mixer snapshots.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "snapshot_restore",
    description: "Put the mixer back to a saved snapshot. Saves the current settings as a new snapshot first, so restoring can itself be undone.",
    inputSchema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"], additionalProperties: false },
  },
  {
    name: "bounce",
    description:
      "Render the song to a WAV file in ~/Music/Mixtools/Bounces. Saves the song first. With 'stems', also renders each named track alone (by soloing it).",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string", description: "Short label for the file name, for example 'before vocal eq'." },
        stems: { type: "array", items: { type: "string" }, description: "Track names to render alone." },
      },
      required: ["label"],
      additionalProperties: false,
    },
  },
  {
    name: "audio_measure",
    description:
      "Measure an audio file: integrated loudness (LUFS), loudness range, sample and true peak, RMS, crest factor, clipping, stereo correlation and width, mono compatibility, and the share of energy in seven frequency bands (sub, bass, low_mid, mid, high_mid, presence, brilliance).",
    inputSchema: { type: "object", properties: { path: { type: "string" }, ...range }, required: ["path"], additionalProperties: false },
  },
  {
    name: "audio_compare",
    description:
      "Measure two audio files and report B minus A, plus the largest differences in plain words. Band levels are each file's share of its own energy, so loudness differences do not hide tone differences. Use for before/after bounces or mix vs. reference.",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "string", description: "First file (before, or the reference)." },
        b: { type: "string", description: "Second file (after, or the mix)." },
        a_start: { type: "number", minimum: 0 },
        a_end: { type: "number", minimum: 0 },
        b_start: { type: "number", minimum: 0 },
        b_end: { type: "number", minimum: 0 },
      },
      required: ["a", "b"],
      additionalProperties: false,
    },
  },
  {
    name: "audio_spectrogram",
    description:
      "Draw a spectrogram of an audio file as an image: time left to right, frequency bottom (20 Hz) to top (20 kHz) on a log scale, brightness as energy. Faint lines mark 50, 100, 200, 500 Hz and 1, 2, 5, 10 kHz.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, ...range }, required: ["path"], additionalProperties: false },
  },
  {
    name: "audio_play",
    description:
      "Play an audio file, or start to end seconds of it, through the Mac's speakers or headphones. Stops anything mixtools is already playing. Optionally sets the level a listener hears, from the whole file's loudness: match_with plays it at the same loudness as other files, so the louder one does not win a comparison just by being louder; as_heard_on plays it as a streaming service would; level_lufs plays it at an exact loudness. Use only one of those three. simulate plays it as heard on a phone, in a car, or in mono. Never changes the file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        ...range,
        match_with: { type: "array", items: { type: "string" }, description: "Other files in the comparison. Every file plays at the quietest one's loudness. Pass the same list (in any order) when playing each file." },
        as_heard_on: { type: "string", enum: STREAMING_SERVICES, description: "Play at the level this streaming service would." },
        level_lufs: { type: "number", minimum: -40, maximum: 0, description: "Play at this integrated loudness." },
        simulate: { type: "string", enum: SIMULATIONS, description: "phone: one small speaker, no bass. car: boomy bass, soft highs, road rumble. mono: left and right summed." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "audio_stop",
    description: "Stop playback started by audio_play.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "master_render",
    description:
      "Master a finished mix bounce for streaming release: raise it to a target loudness with a lookahead true-peak limiter, trim silence at the start and end, fade the ring-out, dither, and write a WAV to ~/Music/Mixtools/Masters/<song>/. Never changes the Ardour session. Returns the file, the limiter's work, the mix and master measurements, and warnings when the limiting costs punch. The source must be a mix with no limiter on Ardour's Master bus.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "The mix bounce to master, normally the 'final mix' bounce." },
        target_lufs: { type: "number", minimum: -30, maximum: -5, description: "Integrated loudness to reach, agreed with the person, for example -14 or -11." },
        ceiling_dbtp: { type: "number", minimum: -6, maximum: 0, description: "Highest true peak allowed. Default: -1 dBTP, or -2 dBTP when target_lufs is louder than -14." },
        bit_depth: { type: "integer", enum: [24, 16], description: "Default 24. Use 16 only when the distributor or a CD requires it." },
        trim: { type: "boolean", description: "Trim silence before the first sound and after the ring-out. Default true." },
        fade_out_seconds: { type: "number", minimum: 0, maximum: 10, description: "Longest fade on the ring-out. The fade starts only after the sound drops below -40 dBFS, so it never fades the final notes. Default 1; 0 for none." },
        song: { type: "string", description: "Song name for the folder and file. Default: the bounce's song." },
        label: { type: "string", description: "Version label in the file name. Default: 'master <target> LUFS'." },
      },
      required: ["source", "target_lufs"],
      additionalProperties: false,
    },
  },
  {
    name: "master_versions",
    description:
      "Make alternate versions of an approved master: instrumental (every vocal track muted), tv_mix (lead vocal muted, backing vocals kept), a_cappella (only the vocal tracks), clean (stretches of the vocal tracks silenced, for a radio edit), and stems (groups of tracks alone: drums, bass, music, lead vocal, backing vocals). Ardour renders each version from the mix with only that change, then each is mastered with the master's exact gain, limiter, trim, and fades, so it lines up with the master sample for sample. Stems stay at mix level, without the limiter, so they add up to the mix. Ardour must have the song open with the same mix the master was made from; the tool checks that first. Every mute, solo, and region edit is put back afterwards. Writes beside the master, stems in a Stems folder. Making a version again replaces the earlier file of that version. Making versions takes longer than Claude waits for one tool call, so this tool starts a background job and returns its job_id at once. Call job_status with that job_id until its status is done or failed; the result is in job_status's result. Until then, tools that change Ardour refuse.",
    inputSchema: {
      type: "object",
      properties: {
        master: { type: "string", description: "The approved master, made by master_render." },
        versions: { type: "array", items: { type: "string", enum: VERSIONS }, description: "Which versions to make. Default: instrumental and stems." },
        vocal_tracks: { type: "array", items: { type: "string" }, description: "Every vocal track (lead and backing). Default: tracks whose names say vocal, vox, backing, harmony, and so on." },
        lead_tracks: { type: "array", items: { type: "string" }, description: "The lead vocal tracks, muted for tv_mix. Default: the vocal tracks that are not backing vocals." },
        clean_spans: {
          type: "array",
          items: {
            type: "object",
            properties: {
              start: { type: ["number", "string"], description: "Seconds or \"1:23.4\"." },
              end: { type: ["number", "string"], description: "Seconds or \"1:23.9\"." },
            },
            required: ["start", "end"],
            additionalProperties: false,
          },
          description: "For clean: each word or phrase to silence on the vocal tracks, as song times. Each up to 5 seconds.",
        },
        stem_groups: {
          type: "object",
          additionalProperties: { type: "array", items: { type: "string" } },
          description: "Stem name to track names, for example {\"Drums\": [\"Kick\", \"Snare\"], \"Keys\": [\"Piano\"]}. Default: groups by track role.",
        },
      },
      required: ["master"],
      additionalProperties: false,
    },
  },
  {
    name: "job_status",
    description:
      "Wait for a background job, such as one started by master_versions, and report it. Waits until the job finishes or wait_seconds pass, whichever comes first. Returns status running, done, or failed, the progress so far, and, when done, the job's result. While the status is running, call it again.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "The job_id the starting tool returned." },
        wait_seconds: { type: "number", minimum: 0, maximum: 50, description: "Longest wait for the job to finish. Default 45." },
      },
      required: ["job_id"],
      additionalProperties: false,
    },
  },
  {
    name: "song_archive",
    description:
      "Zip a song into ~/Music/Mixtools/Archives for backup or to hand it to someone: the Ardour session with all its recordings, the masters, versions, and stems, the final mix bounce (or all bounces, or none), the mix notes, and a read-me on how to reopen it. Saves the song first if Ardour has it open. Checks the zip after writing it. Never changes or deletes the song.",
    inputSchema: {
      type: "object",
      properties: {
        song: { type: "string", description: "Song name or folder. Default: the song open in Ardour." },
        bounces: { type: "string", enum: BOUNCE_CHOICES, description: "final (default): the latest 'final mix' bounce and its stems. all: every bounce. none." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "release_check",
    description:
      "Check whether an audio file is ready to send to a distributor for streaming: file format, sample rate, channels, loudness, true peak, clipping, peaks after a 256 kbps AAC encode, silence and clicks at the start and end, mono, and punch and loudness range against reference songs. Returns pass, warn, fail, or skipped per check with a plain-words note, a verdict, and how much each streaming service turns the song up or down.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The master to check." },
        target_lufs: { type: "number", description: "The loudness agreed with the person. Without it, the check uses -16 to -9 LUFS." },
        ceiling_dbtp: { type: "number", description: "The true-peak ceiling. Default: -1 dBTP, or -2 dBTP when the file is louder than -14 LUFS." },
        references: { type: "array", items: { type: "string" }, description: "Reference songs to compare punch and loudness range with. Default: every song in the References folder. An empty list skips the comparison." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "vocal_sibilance",
    description:
      "Find the \"s\", \"sh\", and \"t\" sounds in a vocal stem and predict exactly what the Mixtools De-Esser would do to each one at given settings, without changing anything. Returns how many s sounds there are, how many the settings touch and by how much, the loudest ones with their times, listening windows around the most-reduced ones, and how much non-s sound the settings would also turn down (which dulls a voice). Without threshold_db, suggests a threshold that touches only the loudest quarter of the s sounds.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "A vocal stem bounce (bounce with stems)." },
        frequency: { type: "number", minimum: 2000, maximum: 12000, description: "Split frequency in Hz. Default 5500. Higher touches only the hissiest part." },
        threshold_db: { type: "number", minimum: -60, maximum: 0, description: "Threshold in dB. Default: the suggested threshold." },
        max_reduction_db: { type: "number", minimum: 0, maximum: 18, description: "Most reduction in dB. Default 4." },
        ...range,
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "moment_mark",
    description:
      "Record a note the person gives at a time in the song, such as \"at 1:23 the vocal disappears\": add an Ardour marker named with the time and their words, move Ardour's playhead there (stopping playback), and log the note in the mix notes. Times are song times, as in a bounce, where 0:00 is the start of the session. Without a time, marks where Ardour's playhead is, so the person can stop playback at the spot.",
    inputSchema: {
      type: "object",
      properties: {
        time: { type: ["number", "string"], description: "Seconds (83) or minutes:seconds (\"1:23\"). Default: where Ardour's playhead is." },
        note: { type: "string", description: "The person's words, short, for example 'vocal disappears'." },
      },
      required: ["note"],
      additionalProperties: false,
    },
  },
  {
    name: "moment_check",
    description:
      "Measure one moment of a mix bounce against the whole song, without changing anything. Uses the stems bounced with it (bounce with stems of the tracks involved first). For each track: whether it plays there, how loud it is there against its usual level, and how much higher or lower it sits against the rest of the mix than usual, which shows a part getting buried or jumping out. Also the phrase around the moment (from the silent gap before it to the one after, safe points to split a region), the mix's tone there against the whole song, peaks and clipping there, findings in plain words, a play_window for audio_play, and Ardour sample positions when the bounce belongs to the open song.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "A mix bounce (not a stem)." },
        time: { type: ["number", "string"], description: "Seconds (83) or minutes:seconds (\"1:23\")." },
        window_seconds: { type: "number", minimum: 1, maximum: 10, description: "How much audio around the time to measure. Default 3." },
        stems: { type: "array", items: { type: "string" }, description: "Stem files to use. Default: the stems bounced with this mix." },
      },
      required: ["path", "time"],
      additionalProperties: false,
    },
  },
  {
    name: "journal_read",
    description:
      "Read a song's mix notes (Mix notes.md in the song folder): what the person wants (goals, references, loudness target, likes and dislikes) and a dated log of complaints, changes, bounces, snapshots, masters, and decisions. Also returns the song's snapshots, latest bounces, and masters. With no song and no song open in Ardour, lists every song with its latest note instead. Call at the start of every conversation about a song.",
    inputSchema: {
      type: "object",
      properties: {
        song: { type: "string", description: "Song name or folder. Default: the song open in Ardour." },
        entries: { type: "integer", minimum: 1, maximum: 500, description: "How many of the latest log lines to return. Default 30." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "journal_write",
    description:
      "Write to a song's mix notes. 'log' adds one dated line: the person's complaint in their words, what you changed, and what they chose. 'about' replaces the About section: the person's goals, references, agreed loudness target, likes and dislikes, and open issues. Bounces, snapshots, restores, masters, and release checks are logged automatically, so log the reasons, not the file names.",
    inputSchema: {
      type: "object",
      properties: {
        log: { type: "string", description: "One line for the log." },
        about: { type: "string", description: "The full new About section, as short Markdown bullet lines. Include everything still true; it replaces the old text." },
        song: { type: "string", description: "Song name or folder. Default: the song open in Ardour." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "part_write",
    description:
      `Write an instrument part for the song as a note list, and turn it into a MIDI file in the song folder (mixtools-parts). Writing a part with an existing name replaces that part's files; it does not touch Ardour. Then call midi_import to put it on a track. The note list format:\n${parts.FORMAT}`,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Part name, for example \"Bass\" or \"Ranat intro\". Also the default track name." },
        notes: { type: "string", description: "The note list." },
        song: { type: "string", description: "Song name or folder. Default: the song open in Ardour." },
      },
      required: ["name", "notes"],
      additionalProperties: false,
    },
  },
  {
    name: "part_read",
    description: "Read back a part's note list, to revise it. With no name, list the song's parts.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Part name." },
        song: { type: "string", description: "Song name or folder. Default: the song open in Ardour." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "midi_import",
    description:
      "Put a part, or any MIDI file, on a new MIDI track in the song open in Ardour, with an instrument plugin. The part follows the song's tempo and starts at the given bar and beat. With replace, a MIDI track of the same name is swapped for the new one, after a full backup of the song; use it to revise a part. Needs the mixtools build of Ardour 9.8.2 or later.",
    inputSchema: {
      type: "object",
      properties: {
        part: { type: "string", description: "Name of a part written with part_write." },
        file: { type: "string", description: "Absolute path of a MIDI file, instead of a part." },
        track_name: { type: "string", description: "Track name. Default: the part's name or the file's name." },
        instrument: { type: "string", description: "Plugin id of the instrument, from ardour_call plugin_list_available. Default: General MIDI Synth, which plays the part's program sound." },
        bar: { type: "integer", minimum: 1, description: "Bar where the part starts. Default 1." },
        beat: { type: "number", minimum: 1, description: "Beat in that bar, may be fractional. Default 1." },
        replace: { type: "boolean", description: "Replace the MIDI track that has this name." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ardour_lua",
    description:
      "Run a Lua script inside Ardour with Ardour's Lua API, for changes no other tool makes: the tempo map, automation, MIDI controller edits, plugin setup, region edits. The global Session is the open song. Before the script, saves a full backup of the song as an Ardour snapshot. The script cannot run programs or read or write files. Returns what it printed, its return values, any error with its line number, and the backup. Prefer a dedicated mixtools or Ardour tool when one does the job. Needs the mixtools build of Ardour 9.8.2 or later.",
    inputSchema: {
      type: "object",
      properties: {
        script: { type: "string", description: "Lua source. Its return values come back as text." },
        purpose: { type: "string", description: "One plain sentence for the song's mix notes saying what the script does." },
        timeout_seconds: { type: "integer", minimum: 1, maximum: 60, description: "Stop the script after this many seconds. Default 10." },
      },
      required: ["script", "purpose"],
      additionalProperties: false,
    },
  },
  {
    name: "song_restore_backup",
    description:
      "Put the song back to a full backup that midi_import or ardour_lua saved, undoing everything since. Ardour must be closed: ask the person to quit Ardour without saving first. Keeps a copy of the song's state before the restore, then opens the song.",
    inputSchema: {
      type: "object",
      properties: { file: { type: "string", description: "The backup's .ardour file, from the backup.file field of midi_import or ardour_lua." } },
      required: ["file"],
      additionalProperties: false,
    },
  },
  {
    name: "reference_list",
    description: "List the reference songs in ~/Music/Mixtools/References with their length and loudness.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "selftest_song",
    description:
      `Make the self-test song: write generated stems (Kick, Snare, Bass, stereo Keys, Lead Vocal with "s" sounds, Backing Vocals in the chorus; 25 s at 120 BPM) to ~/Music/Mixtools/Self-Test Audio, create the song "${SELFTEST_SONG}" from them, and open it in Ardour. First deletes the previous self-test song with its bounces, masters, and archives; never touches any other song. Ardour must be closed. Returns the song, its sections, the lead vocal phrase times, and what the later checks should find. Use only when running the mixtools self-test.`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "feedback_note",
    description:
      "Add one dated line to the notes for the mixtools team (~/Music/Mixtools/Reports/Notes for the mixtools team.md). kind 'problem': a mixtools tool failed, returned something wrong, or Ardour misbehaved. 'struggle': the person got confused, stuck, or frustrated, or had to repeat themselves. 'idea': something mixtools cannot do yet that would have helped, whether the person asked for it or you noticed it. Write the note so a developer who was not here understands it: what was attempted, what happened, and any error text. Returns how many notes no report has included yet.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: feedback.KINDS },
        note: { type: "string", description: "What happened or what would help, in one or two sentences, with tool names and error text." },
        quote: { type: "string", description: "The person's own words, when they said something about it." },
        song: { type: "string", description: "Song name, when it happened in a song." },
      },
      required: ["kind", "note"],
      additionalProperties: false,
    },
  },
  {
    name: "feedback_report",
    description:
      "Write a report for the mixtools team to ~/Music/Mixtools/Reports: a summary, the mixtools, Ardour, and macOS versions, every note no earlier report included, the self-test results when given, and the current status. Marks those notes as reported. With show_in_finder, opens a Finder window with the report selected, so the person can drag it into a message or email.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Two or three sentences for the team: what the person was doing and what matters most in this report." },
        selftest: {
          type: "array",
          items: {
            type: "object",
            properties: {
              step: { type: "string" },
              result: { type: "string", enum: feedback.RESULTS },
              detail: { type: "string", description: "What the step found, the fix applied, or the error text." },
            },
            required: ["step", "result"],
            additionalProperties: false,
          },
          description: "Self-test results, one per step, in order.",
        },
        show_in_finder: { type: "boolean", description: "Open a Finder window with the report selected." },
      },
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// Tool implementations

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function status() {
  const problems = [];
  const version = await ardour.appVersion();
  const running = await ardour.isRunning();
  let session = null, mcp = false, importTool = false, midiTool = false, luaTool = false;
  try {
    session = await ardour.sessionInfo();
    mcp = true;
    const names = new Set((await ardour.listTools()).map((t) => t.name));
    importTool = names.has("session_import_audio");
    midiTool = names.has(ardour.MIDI_IMPORT_TOOL);
    luaTool = names.has(ardour.LUA_TOOL);
  } catch {}
  // Ardour rewrites its settings file while it runs, so a connected MCP
  // server is the better answer while Ardour is open.
  const saved = await ardour.mcpEnabledInConfig();
  const enabled = mcp ? true : saved;
  const deesser = await deesserStatus();
  const audioApps = await otherAudioApps();
  const microphone = version ? await microphoneAccess() : "unknown";
  const folders = {};
  for (const [k, p] of Object.entries({ songs: ardour.SONGS, references: ardour.REFERENCES, bounces: ardour.BOUNCES, masters: ardour.MASTERS })) {
    folders[k] = { path: p, exists: await exists(p) };
  }

  if (!version) problems.push({ problem: "Ardour is not installed in /Applications.", fix: "Install the Ardour build that came with mixtools: open its disk image and drag Ardour9 into Applications." });
  if (version && enabled === null) problems.push({ problem: "Ardour has never been opened.", fix: "Ask the person to open Ardour once, click through its first-run window, then quit it. Then call mixtools_setup." });
  if (version && enabled === false && !mcp) problems.push({ problem: "Ardour's MCP server is off.", fix: running ? "Ask the person to quit Ardour, then call mixtools_setup." : "Call mixtools_setup." });
  if (running && !mcp && enabled) problems.push({ problem: "Ardour is open but its MCP server is not answering.", fix: "If Ardour is still starting or showing a window, ask the person to finish it. If Ardour shows an audio error such as \"failed to start process thread\", fix the other audio app and microphone problems in this list, then ask the person to quit Ardour and call song_open again. If no song is open, call song_open or song_new." });
  if (audioApps.length) {
    const apps = audioApps.join(" and ");
    problems.push({
      problem: `${apps} ${audioApps.length === 1 ? "is" : "are"} open. Another audio app can hold the Mac's sound, which stops Ardour's audio from starting ("failed to start process thread") or makes it freeze.`,
      fix: `Ask the person to save their work in ${apps} and quit ${audioApps.length === 1 ? "it" : "them"}.${running ? " If Ardour's audio has stopped or failed, also ask them to quit Ardour, then open the song again with song_open." : ""}`,
    });
  }
  if (microphone === "denied") {
    problems.push({
      problem: "macOS does not let Ardour use the microphone, which can stop Ardour's audio from starting.",
      fix: `Ask the person to open System Settings, then Privacy & Security, then Microphone, and turn on Ardour9.${running ? " Then ask them to quit Ardour and open the song again with song_open." : ""}`,
    });
  }
  if (mcp && !importTool) problems.push({ problem: "This Ardour cannot import audio for mixtools.", fix: "Install the Ardour build that came with mixtools; the standard Ardour download lacks the import tool." });
  if (mcp && importTool && (!midiTool || !luaTool)) {
    problems.push({
      problem: "This is an older mixtools build of Ardour. It cannot add instrument parts (midi_import) or run scripts (ardour_lua). Mixing still works.",
      fix: "Tell the person that writing instrument parts needs the newer mixtools build of Ardour, Ardour-9.8.2-universal.dmg or later, from whoever gave them mixtools. When they have it, follow the mixtools-setup skill to install it.",
    });
  }
  if (version && enabled !== null && !deesser.current) {
    problems.push({
      problem: deesser.installed ? "The Mixtools De-Esser in Ardour is out of date." : "The Mixtools De-Esser is not installed in Ardour.",
      fix: `Call mixtools_setup.${running ? " Then ask the person to save and quit Ardour and open the song again, because Ardour finds plugins only when it starts." : ""}`,
    });
  }
  // master_render creates Masters on first use, so only the others count.
  if ([folders.songs, folders.references, folders.bounces].some((f) => !f.exists)) problems.push({ problem: "Workspace folders are missing.", fix: "Call mixtools_setup." });

  return {
    mixtools_version: VERSION,
    ardour: { installed: !!version, version, open: running, mcp_server_on: enabled, mcp_connected: mcp, import_supported: importTool, midi_import_supported: midiTool, lua_supported: luaTool, microphone_access: microphone },
    other_audio_apps: audioApps,
    song: session ? { name: session.sessionName, path: session.path, unsaved_changes: session.dirty, sample_rate: session.sampleRate } : null,
    workspace: folders,
    deesser: { name: "Mixtools De-Esser", installed: deesser.installed, up_to_date: deesser.current, plugin_id: deesser.plugin_id },
    feedback: { unsent_notes: await feedback.unsentCount().catch(() => 0), notes_file: feedback.NOTES_FILE, reports_folder: feedback.REPORTS },
    problems,
  };
}

async function setup() {
  const created = [];
  for (const p of [ardour.SONGS, ardour.REFERENCES, ardour.BOUNCES, ardour.MASTERS]) {
    if (!(await exists(p))) {
      await fs.mkdir(p, { recursive: true });
      created.push(p);
    }
  }
  let connected = false;
  try {
    await ardour.sessionInfo();
    connected = true;
  } catch {}
  const enabled = await ardour.mcpEnabledInConfig();
  const mcp = enabled || connected ? { changed: false, reason: "already on" } : await ardour.enableMcpInConfig();
  // Ardour decides it is running for the first time by its settings, so
  // install nothing into its settings folder before it has run once.
  const deesser = enabled === null ? { changed: false, reason: "Ardour has not been opened yet." } : await installDeesser();
  return { created_folders: created, ardour_mcp_server: mcp, deesser, status: await status() };
}

let player = null;
let tempClip = null;

async function play(file, opts) {
  const { start, end } = opts;
  await stopPlayback();
  const prepared = await preparePlayback(file, opts);
  let target = file;
  if (prepared || start != null || end != null) {
    const audio = prepared?.audio ?? (await loadAudio(file, { start, end }));
    tempClip = path.join(os.tmpdir(), `mixtools-clip-${process.pid}.wav`);
    await fs.writeFile(tempClip, encodeWavFloat(audio));
    target = tempClip;
  }
  player = spawn("/usr/bin/afplay", [target], { stdio: "ignore" });
  player.on("exit", () => (player = null));
  return { playing: path.basename(file), start: start ?? 0, end: end ?? null, ...(prepared ? { level: prepared.info } : {}) };
}

async function stopPlayback() {
  if (player) {
    player.kill();
    player = null;
  }
  return { stopped: true };
}

async function referenceList() {
  let names = [];
  try {
    names = await fs.readdir(ardour.REFERENCES);
  } catch {
    return { folder: ardour.REFERENCES, references: [], note: "The folder does not exist yet. Call mixtools_setup." };
  }
  const refs = [];
  for (const n of names.sort()) {
    if (!AUDIO_EXTS.has(path.extname(n).toLowerCase())) continue;
    const p = path.join(ardour.REFERENCES, n);
    try {
      const m = await measure(p);
      refs.push({ file: p, seconds: m.seconds, loudness_lufs: m.loudness_lufs });
    } catch (e) {
      refs.push({ file: p, error: e.message });
    }
  }
  return { folder: ardour.REFERENCES, references: refs };
}

async function ardourTools({ filter, name }) {
  const tools = await ardour.listTools();
  if (name) {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`Ardour has no tool named ${name}.`);
    return t;
  }
  const f = (filter || "").toLowerCase();
  return tools.filter((t) => !f || t.name.includes(f)).map((t) => ({ name: t.name, description: t.description }));
}

// ---------------------------------------------------------------------------
// Instrument parts and scripts

async function needTool(name) {
  const names = new Set((await ardour.listTools()).map((t) => t.name));
  if (!names.has(name)) {
    throw new Error("This Ardour is an older mixtools build without instrument parts and scripts. Call mixtools_status and follow its fix.");
  }
}

async function midiImport(a) {
  if (!!a.part === !!a.file) throw new Error("Give either 'part' or 'file'.");
  await needTool(ardour.MIDI_IMPORT_TOOL);
  const dir = await songDir();
  if (!dir) throw new Error("No song is open in Ardour. Open the song first.");
  let file = a.file;
  let partName = null;
  if (a.part) {
    const p = await parts.readPart(dir, a.part);
    file = p.midi_file;
    partName = p.part;
  } else if (!path.isAbsolute(file) || !(await exists(file))) {
    throw new Error(`No MIDI file at ${file}. Give an absolute path.`);
  }
  const trackName = a.track_name || partName || path.basename(file).replace(/\.[^.]+$/, "");

  const existing = (await ardour.tracks()).find((t) => t.name.toLowerCase() === trackName.toLowerCase());
  let backup = null;
  if (existing) {
    if (!a.replace) throw new Error(`The song already has a track named "${existing.name}". Pass replace: true to swap it for this part, or give another track_name.`);
    if (existing.type !== "midi_track") throw new Error(`"${existing.name}" is not a MIDI track, so midi_import will not replace it. Give another track_name.`);
    backup = await ardour.fullBackup();
  }

  const imported = await ardour.importMidi(file, { trackName, instrument: a.instrument, bar: a.bar, beat: a.beat });
  if (!imported.length) throw new Error("Ardour imported nothing from the file.");
  if (existing) {
    await ardour.removeTrack(existing.id);
    if (imported.length === 1 && imported[0].trackName !== existing.name) {
      await ardour.renameTrack(imported[0].trackId, existing.name);
      imported[0].trackName = existing.name;
    }
  }
  await ardour.call("session_save");

  const what = partName ? `part "${partName}"` : path.basename(file);
  await autoLog(songDir(),
    `${existing ? "Replaced" : "Added"} ${what} on track${imported.length === 1 ? "" : "s"} ${imported.map((t) => `"${t.trackName}" (${t.instrument}, ${t.notes} notes, from ${t.positionBbt?.text ?? "1|1|0"})`).join(", ")}.${backup ? ` Backup before replacing: ${backup.snapshot}.` : ""}`);
  return {
    tracks: imported.map((t) => ({ track: t.trackName, id: t.trackId, instrument: t.instrument, notes: t.notes, starts_at: t.positionBbt?.text, controllers: t.controllers })),
    replaced: existing ? existing.name : null,
    backup,
  };
}

async function ardourLua(a) {
  await needTool(ardour.LUA_TOOL);
  const purpose = String(a.purpose ?? "").replace(/\s+/g, " ").trim();
  if (!purpose) throw new Error("Give 'purpose': one plain sentence saying what the script does.");
  const backup = await ardour.fullBackup();
  const r = await ardour.runLua(a.script, a.timeout_seconds ?? 10);
  await autoLog(songDir(), `Script: ${purpose} ${r.ok ? "It ran." : `It failed: ${String(r.error).split("\n")[0]}`} Backup before it: ${backup.snapshot}.`);
  return {
    ...r,
    backup: { ...backup, restore: "To undo everything the script changed, ask the person to quit Ardour without saving, then call song_restore_backup with backup.file." },
  };
}

// ---------------------------------------------------------------------------
// Journal

/** The song folder for a name or path, or the song open in Ardour. Null if neither. */
async function songDir(song) {
  if (song) {
    let p = song.endsWith(".ardour") ? path.dirname(song) : song;
    if (path.isAbsolute(p) && (await exists(p))) return p;
    const match = (await ardour.listSongs()).find((x) => x.song.toLowerCase() === String(song).toLowerCase());
    if (match) return match.path;
    throw new Error(`No song named "${song}". Call journal_read with no song to list them.`);
  }
  try {
    return (await ardour.sessionInfo()).path.replace(/\/$/, "");
  } catch {
    return null;
  }
}

/** The song folder that a file in Bounces/<song>/ or Masters/<song>/ belongs to. */
async function songDirForFile(file) {
  const parent = path.dirname(path.resolve(file));
  const root = path.dirname(parent);
  if (root === ardour.BOUNCES || root === ardour.MASTERS) {
    const dir = path.join(ardour.SONGS, path.basename(parent));
    if (await exists(dir)) return dir;
  }
  return songDir();
}

/** Log to the journal without ever failing the tool that triggered it. */
async function autoLog(dirPromise, text) {
  try {
    const dir = await dirPromise;
    if (dir) await journal.append(dir, text);
  } catch {}
}

async function listFiles(dir, keep) {
  try {
    return (await fs.readdir(dir)).filter(keep).sort();
  } catch {
    return [];
  }
}

async function journalRead({ song, entries }) {
  const dir = await songDir(song);
  if (!dir) {
    const songs = [];
    for (const s of await ardour.listSongs()) songs.push({ ...s, latest_note: await journal.lastEntry(s.path) });
    return { open_song: null, note: "No song is open in Ardour. Ask which song to work on, or offer the one with the latest note, then call song_open.", songs };
  }
  const name = path.basename(dir);
  let snapshots = [];
  try {
    snapshots = JSON.parse(await fs.readFile(path.join(dir, "mixtools-snapshots.json"), "utf8")).map((x) => ({ id: x.id, label: x.label, time: x.time }));
  } catch {}
  const bounceDir = path.join(ardour.BOUNCES, name);
  const masterDir = path.join(ardour.MASTERS, name);
  return {
    song: name,
    path: dir,
    notes: await journal.read(dir, entries ?? 30),
    snapshots: snapshots.slice(-10),
    snapshot_count: snapshots.length,
    latest_bounces: (await listFiles(bounceDir, (f) => f.endsWith(".wav") && !f.includes("-stem-"))).slice(-5).map((f) => path.join(bounceDir, f)),
    masters: (await listFiles(masterDir, (f) => f.endsWith(".wav"))).map((f) => path.join(masterDir, f)),
  };
}

async function journalWrite({ log, about, song }) {
  if (!log && about == null) throw new Error("Give 'log', 'about', or both.");
  const dir = await songDir(song);
  if (!dir) throw new Error("No song is open in Ardour. Pass 'song'.");
  if (about != null) await journal.setAbout(dir, about);
  if (log) await journal.append(dir, log);
  return { song: path.basename(dir), file: journal.journalPath(dir), wrote: { about: about != null, log: !!log } };
}

// ---------------------------------------------------------------------------
// Timestamp notes

async function momentMark({ time, note }) {
  const text = String(note ?? "").replace(/\s+/g, " ").trim();
  if (!text) throw new Error("Give the person's note.");
  let info;
  try {
    info = await ardour.sessionInfo();
  } catch {
    throw new Error("Ardour is not open with a song. Open the song first.");
  }
  const start = await ardour.sessionStartSample();
  let sample;
  if (time == null) {
    // Mark where the person stopped Ardour's playhead.
    sample = await ardour.stopAndReadPlayhead();
    if (sample < start) throw new Error("Ardour's playhead is before the start of the song. Ask the person to play to the spot and stop there.");
  } else {
    sample = start + Math.round(parseTime(time) * info.sampleRate);
  }
  const t = (sample - start) / info.sampleRate;
  const name = `${formatTime(t)} ${text}`.slice(0, 60);
  const marker = await ardour.addMarkerAt(sample, name);
  await autoLog(songDir(), `Note at ${formatTime(t)}: "${text}". Marked in Ardour.`);
  return { marker: name, time: formatTime(t), seconds: Math.round(t * 100) / 100, ...marker, playhead: "at the marker; playback stopped" };
}

/** Map song seconds to Ardour samples when the bounce belongs to the open song. */
async function sampleMapFor(file) {
  try {
    const info = await ardour.sessionInfo();
    const open = info.path.replace(/\/$/, "");
    if ((await songDirForFile(file)) !== open) return null;
    const start = await ardour.sessionStartSample();
    return (s) => start + Math.round(s * info.sampleRate);
  } catch {
    return null;
  }
}

const HANDLERS = {
  mixtools_status: () => status(),
  mixtools_setup: () => setup(),
  song_new: async (a) => {
    const r = await ardour.newSong(a.name, a.files, a.track_names);
    await autoLog(r.path, `Song created from ${a.files.length} file${a.files.length === 1 ? "" : "s"}: ${a.files.map((f) => path.basename(f)).join(", ")}.`);
    return r;
  },
  song_open: async (a) => (a.path ? ardour.openSong(a.path) : { songs: await ardour.listSongs() }),
  ardour_tools: (a) => ardourTools(a),
  ardour_call: (a) => {
    if (a.name === ardour.LUA_TOOL) throw new Error("Use ardour_lua to run a script. It saves a backup of the song first.");
    return ardour.call(a.name, a.arguments ?? {});
  },
  part_write: async (a) => {
    const dir = await songDir(a.song);
    if (!dir) throw new Error("No song is open in Ardour. Pass 'song'.");
    const r = await parts.writePart(dir, a.name, a.notes);
    await autoLog(dir, `Part "${r.part}" written: ${r.notes} notes over ${r.beats} beats.`);
    return { ...r, next: `Call midi_import with part "${r.part}".` };
  },
  part_read: async (a) => {
    const dir = await songDir(a.song);
    if (!dir) throw new Error("No song is open in Ardour. Pass 'song'.");
    return a.name ? parts.readPart(dir, a.name) : { song: path.basename(dir), parts: await parts.listParts(dir) };
  },
  midi_import: (a) => midiImport(a),
  song_restore_backup: async (a) => {
    const r = await ardour.restoreBackup(a.file);
    await autoLog(songDir(), `Restored the song from backup ${path.basename(a.file)}. The state before the restore is kept as ${path.basename(r.previous_state_kept_as)}.`);
    return r;
  },
  ardour_lua: (a) => ardourLua(a),
  snapshot_save: async (a) => {
    const r = await ardour.snapshotSave(a.label);
    await autoLog(songDir(), `Snapshot ${r.id} saved: "${r.label}".`);
    return r;
  },
  mix_starting_balance: async (a) => {
    const r = await startingBalance(a);
    const set = r.tracks.filter((t) => !t.left_alone);
    await autoLog(songDir(),
      `Starting balance: faders set on ${set.length} track${set.length === 1 ? "" : "s"} (${set.map((t) => `${t.track} ${t.fader_db} dB as ${t.role.replace(/_/g, " ")}`).join(", ")}). Mix peaks at ${r.mix.true_peak_dbtp} dBTP. Snapshot ${r.snapshots.before} has the levels before.`);
    return r;
  },
  snapshot_list: () => ardour.snapshotList(),
  snapshot_restore: async (a) => {
    const r = await ardour.snapshotRestore(a.id);
    await autoLog(songDir(), `Restored snapshot ${r.restored.id} ("${r.restored.label}"). The settings before the restore are snapshot ${r.safety_snapshot.id}.`);
    return r;
  },
  bounce: async (a) => {
    const r = await ardour.bounce(a.label, a.stems ?? []);
    await autoLog(songDir(), `Bounce "${a.label}": ${path.basename(r.mix)}${r.stems.length ? ` with stems of ${r.stems.map((x) => x.track).join(", ")}` : ""}.`);
    return r;
  },
  audio_measure: (a) => measure(a.path, a),
  audio_compare: (a) => compare(a.a, a.b, { start: a.a_start, end: a.a_end }, { start: a.b_start, end: a.b_end }),
  audio_spectrogram: async (a) => {
    const { png, seconds } = await spectrogram(a.path, a);
    return {
      content: [
        { type: "image", data: png.toString("base64"), mimeType: "image/png" },
        {
          type: "text",
          text: `Spectrogram of ${path.basename(a.path)}, ${seconds.toFixed(1)} s shown. Time runs left to right. Frequency runs from 20 Hz at the bottom to 20 kHz at the top on a log scale; faint lines mark ${SPECTROGRAM_GRID_HZ.join(", ")} Hz. Brighter means more energy (90 dB range).`,
        },
      ],
    };
  },
  audio_play: (a) => play(a.path, a),
  audio_stop: () => stopPlayback(),
  master_render: async (a) => {
    const r = await renderMaster(a, { mastersDir: ardour.MASTERS, bouncesDir: ardour.BOUNCES });
    const m = r.master_measurement;
    await autoLog(songDirForFile(r.master),
      `Master "${path.basename(r.master)}" from ${path.basename(a.source)}: ${m.loudness_lufs} LUFS, ${m.true_peak_dbtp} dBTP, limiter up to ${r.limiter.max_reduction_db} dB.${r.warnings.length ? ` ${r.warnings.length} warning${r.warnings.length === 1 ? "" : "s"}.` : ""}`);
    return r;
  },
  master_versions: async (a) =>
    jobs.startJob("versions", async (progress) => {
      const r = await makeVersions(a, progress);
      const made = [...r.versions.map((v) => v.version.replace(/_/g, " ")), ...(r.stems.length ? [`${r.stems.length} stems`] : [])];
      await autoLog(songDirForFile(a.master), `Versions of "${path.basename(a.master)}": ${made.join(", ")}.${r.clean_spans ? ` Clean edit silences ${r.clean_spans.map((s) => `${s.start}-${s.end}`).join(", ")}.` : ""}`);
      return r;
    }),
  job_status: (a) => jobs.jobStatus(a),
  song_archive: async (a) => {
    const dir = await songDir(a.song);
    if (!dir) throw new Error("No song is open in Ardour. Pass 'song'.");
    const r = await archiveSong(dir, { bounces: a.bounces ?? "final" });
    await autoLog(dir, `Archived to ${path.basename(r.archive)} (${r.size_mb} MB).`);
    return r;
  },
  release_check: async (a) => {
    const r = await releaseCheck(a, { referencesDir: ardour.REFERENCES, audioExts: AUDIO_EXTS });
    await autoLog(songDirForFile(a.path), `Release check on ${path.basename(a.path)}: ${r.verdict}`);
    return r;
  },
  vocal_sibilance: (a) => sibilance(a.path, a),
  moment_mark: (a) => momentMark(a),
  moment_check: async (a) => momentCheck(a.path, a, await sampleMapFor(a.path)),
  journal_read: (a) => journalRead(a),
  journal_write: (a) => journalWrite(a),
  reference_list: () => referenceList(),
  selftest_song: () => selftestSong(),
  feedback_note: (a) => feedback.addNote(a, VERSION),
  feedback_report: async (a) => feedback.makeReport(a, { version: VERSION, status: await status() }),
};

// ---------------------------------------------------------------------------
// MCP over stdio

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

// Tools that change Ardour, or render through it. They wait while a
// background job uses Ardour, so nothing changes the mix under the job.
const CHANGES_ARDOUR = new Set([
  "mixtools_setup", "song_new", "song_open", "ardour_call", "mix_starting_balance", "snapshot_save", "snapshot_restore",
  "bounce", "master_versions", "song_archive", "moment_mark", "selftest_song", "midi_import", "ardour_lua", "song_restore_backup",
]);

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notification
  try {
    if (method === "initialize") {
      return send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "mixtools", version: VERSION },
        },
      });
    }
    if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
    if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    if (method === "tools/call") {
      const handler = HANDLERS[params?.name];
      if (!handler) return send({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${params?.name}` } });
      try {
        const busy = jobs.runningJob();
        if (busy && CHANGES_ARDOUR.has(params.name)) throw new Error(jobs.busyMessage(busy));
        const out = await handler(params.arguments ?? {});
        const result = out?.content ? out : { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
        return send({ jsonrpc: "2.0", id, result });
      } catch (e) {
        return send({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: e.message }] } });
      }
    }
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (e) {
    send({ jsonrpc: "2.0", id, error: { code: -32603, message: e.message } });
  }
}

const pending = new Set();
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  const p = handle(msg).finally(() => pending.delete(p));
  pending.add(p);
});
rl.on("close", async () => {
  await Promise.allSettled([...pending]);
  await stopPlayback();
  if (tempClip) await fs.rm(tempClip, { force: true });
  process.exit(0);
});
