# Mixtools tools

The mixtools desktop extension runs on the person's Mac and provides these tools. It drives Ardour through Ardour's built-in MCP server, which listens on this Mac only.

The workspace folder is `~/Music/Mixtools/`:

| Folder | What goes there |
| --- | --- |
| `Songs/<song>/` | One Ardour session per song, made by `song_new`. |
| `References/` | Songs the person wants their mix to sound like. The person adds these. |
| `Bounces/<song>/` | Every bounce, numbered in order: `001-start.wav`, `002-vocal-up.wav`, with stems beside them. |
| `Songs/<song>/Mix notes.md` | The song's mix notes, kept by `journal_write` and the automatic log. The person can read them and add their own lines under Log. |
| `Masters/<song>/` | Release masters made by `master_render`: `<song> (master -14 LUFS).wav`. These are the files to upload. Versions from `master_versions` sit beside them (`<song> (master -14 LUFS, instrumental).wav`), and stems in `Stems (master -14 LUFS)/`. |
| `Archives/` | Song archives made by `song_archive`: `<song> (archive 2026-10-31).zip`. |
| `Reports/` | `Notes for the mixtools team.md`, kept by `feedback_note`, and reports made by `feedback_report`: `Mixtools report 2026-10-31 14-05-09.md`. The person sends reports to the mixtools team. |
| `Self-Test Audio/` | The generated stems `selftest_song` makes the "Mixtools Self-Test" song from. Replaced on every self-test. |

## Setup and songs

| Tool | Does | Returns |
| --- | --- | --- |
| `mixtools_status` | Checks Ardour, its MCP server, the open song, and the workspace. | Ardour version and state, the open song, folders, and a list of problems, each with its fix. |
| `mixtools_setup` | Creates the workspace folders and turns on Ardour's MCP server. The second part needs Ardour closed. Safe to run again. | What changed, and a fresh status. |
| `song_new` | Creates a session in `Songs/`, opens it in Ardour, and imports `files` as one track each, named by `track_names`. Needs Ardour closed. | Song folder and the created tracks. |
| `song_open` | Opens a song. With no `path`, lists the songs instead. | Session info, or the song list. |

## Starting balance

| Tool | Does | Returns |
| --- | --- | --- |
| `mix_starting_balance` | Sets first-pass faders on a new song. Saves snapshot "before starting balance", bounces "raw levels" with every unmuted track as a stem, measures each stem's loudness while it plays, and sets each fader so the track sits at its role's level against the lead. Then moves all faders together so the mix peaks at -6 dBTP, bounces "starting balance", and saves snapshot "starting balance". A track that needs more than the fader's +6 dB gets the rest as clip gain on its regions. `roles` sets a track's role by name; `levels` sets its dB against the lead directly. Refuses when faders have moved, unless `replace_current_levels` is true. | `snapshots` (`before`, `after`), `bounces` (`raw_levels`, `starting_balance`), `tracks` (each with `role`, `level_vs_lead_db`, `raw_level_lufs`, `fader_db_before`, `fader_db`, `clip_gain_added_db`, `recording_clipped_moments`, and `left_alone` for muted or silent tracks), `mix` (true peak, sample peak, loudness), and `notes`. |

Starting levels by role, in dB against the lead vocal while each plays: lead_vocal 0, drums -3, kick -5, bass -5, snare -6, backing_vocals -7, guitar -7, keys -7, synth -8, other -8, overheads -9, pad -11, strings -11, toms -12, percussion -12, cymbals -14, fx -14. These are a first pass for the person's ears, not a finished mix.

`snapshot_restore` with the `before` snapshot puts the faders back. It does not remove clip gain; to remove it, call `region_set_gain_db` with `db` 0 on each region of a track with `clip_gain_added_db` above 0.

## Ardour

| Tool | Does |
| --- | --- |
| `ardour_tools` | Lists Ardour's tools, filtered by `filter`, or returns one tool's schema by `name`. |
| `ardour_call` | Calls an Ardour tool by `name` with `arguments`. See `ardour.md`. |

## Snapshots

| Tool | Does | Returns |
| --- | --- | --- |
| `snapshot_save` | Stores the mixer settings (faders, pans, mutes, solos, plugin settings) under a `label`. | Snapshot id. |
| `snapshot_list` | Lists this song's snapshots. | Id, label, time. |
| `snapshot_restore` | Restores snapshot `id`, after saving the current settings as a safety snapshot. | The restored snapshot and the safety snapshot's id. |

## Bouncing and audio

| Tool | Does | Returns |
| --- | --- | --- |
| `bounce` | Saves the song and renders it to 32-bit float WAV. `stems` renders named tracks alone too. | Paths of the mix and stems. |
| `audio_measure` | Measures one file, or `start` to `end` seconds of it. Reads WAV, AIFF, MP3, M4A, FLAC, and CAF. | Integrated loudness (LUFS), loudness range (LU), short-term and momentary maximum, sample and true peak, RMS, crest factor, clipped samples, samples over full scale, stereo correlation and width, mono loss and warning, and band levels: each band's share of the file's energy in dB (`sub`, `bass`, `low_mid`, `mid`, `high_mid`, `presence`, `brilliance`). |
| `audio_compare` | Measures `a` and `b` and subtracts. | Both measurements, `difference_b_minus_a`, and `largest_differences` in plain words. |
| `audio_spectrogram` | Draws a file's spectrogram. | A PNG image: time left to right, 20 Hz at the bottom to 20 kHz at the top (log scale), with faint lines at 50, 100, 200, 500 Hz and 1, 2, 5, 10 kHz. |
| `audio_play` | Plays a file, or `start` to `end` seconds of it, on the Mac's speakers or headphones. Never changes the file. Level, from the whole file's loudness (use at most one): `match_with` lists the other files in a comparison, and every file plays at the quietest one's loudness (files are only turned down, so nothing clips); `as_heard_on` (`spotify`, `youtube`, `tidal`, `amazon`, `apple_music`) plays it as that service would; `level_lufs` plays it at an exact loudness. `simulate`: `phone` (one small speaker, no bass below about 350 Hz), `car` (cabin bass boost, softer highs, road rumble about 20 dB below the song), or `mono` (left and right summed). | What is playing and, with any option, `level`: `file_lufs`, `gain_db`, `played_at_lufs` (before any simulation), the match or service used, and `turned_down_to_avoid_clipping_db` if the playback had to be turned down. |
| `audio_stop` | Stops playback. | Confirmation. |
| `reference_list` | Lists the references folder. | Each file's length and loudness. |

Bounces are float files, so a mix that goes over full scale shows its true level instead of being cut off. `over_full_scale_samples` counts those samples. A finished release must have none.

## Vocal

| Tool | Does | Returns |
| --- | --- | --- |
| `vocal_sibilance` | Finds the "s", "sh", and "t" sounds in a vocal stem (`path`, optional `start` and `end`) and predicts exactly what the Mixtools De-Esser does to each at `frequency` (default 5500 Hz), `threshold_db` (default: the suggested threshold), and `max_reduction_db` (default 4). Changes nothing. | `s_sounds_found`, `s_sounds_touched`, `touched_outside_s_sounds_seconds` (non-"s" sound the settings would turn down; above 0 risks dulling the voice), `suggested_threshold_db` (touches only the loudest quarter), `loudest_s_sounds` and `touched_s_sounds` (each with `time`, `seconds`, `peak_db`, `reduction_db`), `listening_windows` (3-second spans around the most-reduced ones), `plugin_parameters` to set on the plugin, and `notes`. |

`mixtools_setup` installs the Mixtools De-Esser into Ardour's scripts folder; Ardour loads it when it next starts. `mixtools_status` reports `deesser.installed`, `deesser.up_to_date`, and `deesser.plugin_id`.

## Moments

| Tool | Does | Returns |
| --- | --- | --- |
| `moment_mark` | Adds an Ardour marker at `time` (seconds, or `"1:23"`; default: where Ardour's playhead is), named with the time and the person's `note`. Stops playback and moves the playhead to the marker. Logs the note. | `marker` (its name), `time`, `seconds`, `location_id` (for `markers_rename_by_location_id`), `sample`, and `bar_beat`. |
| `moment_check` | Measures `time` in a mix bounce (`path`) against the whole song, over `window_seconds` (default 3), with the stems bounced with it (or `stems`). Changes nothing. | `mix` (`level_now_lufs`, `typical_level_lufs`, `change_from_typical_db`); `tracks`, each with `playing`, `level_now_lufs`, `typical_level_lufs`, `change_from_typical_db`, `against_rest_now_db` and `against_rest_usually_db` (the track's loudness minus the rest of the mix's), `change_against_rest_db` (negative: buried here; positive: sticks out here), and `phrase` (`start`, `end`, and with the song open, `start_sample` and `end_sample`: the silent gaps around the moment in that track); `tone_vs_whole_song_db` by band; `true_peak_dbtp` and `clipped_samples` there; `findings` in plain words; `play_window` for `audio_play`; and `ardour_sample`. |

Times are song times, the same in every bounce and in Ardour: 0:00 is the start of the session.

## Archive

| Tool | Does | Returns |
| --- | --- | --- |
| `song_archive` | Zips a `song` (default: the one open in Ardour) into `Archives/`: the Ardour session with its recordings (without files Ardour rebuilds, such as waveform pictures), the masters, versions, and stems, the bounces chosen by `bounces` (`final`, the default: the latest "final mix" bounce and its stems; `all`; or `none`), the mix notes, and a read-me. Saves the song first if it is open. Reads the zip back to check it. Never changes the song. | `archive` (the zip's path), `size_mb`, `files`, `contents`, `saved_song_first`, and `warnings` (for example, audio the session uses from outside its folder). |

To reopen an archived song, the person double-clicks the zip, moves the song's session folder into `Songs/`, and you call `song_open`.

## Mix notes

| Tool | Does | Returns |
| --- | --- | --- |
| `journal_read` | Reads a song's mix notes. `song` picks a song by name or folder; the default is the song open in Ardour. `entries` sets how many of the latest log lines come back (default 30). With no song open and no `song`, lists the songs instead. | `notes` (`about`, the latest `log` lines, `total_entries`), the latest 10 `snapshots` and `snapshot_count`, `latest_bounces` (the last 5 mix bounces), and `masters`. With no song: each song with its `latest_note`. |
| `journal_write` | Adds a dated `log` line, replaces the `about` section, or both. | The notes file and what was written. |

These tools log automatically: `song_new`, `mix_starting_balance`, `snapshot_save`, `snapshot_restore`, `bounce`, `moment_mark`, `master_render`, `master_versions`, `release_check`, and `song_archive`. A failed log never fails the tool.

## Mastering

| Tool | Does | Returns |
| --- | --- | --- |
| `master_render` | Masters a mix bounce (`source`) without touching the Ardour session. Raises it to `target_lufs` with a lookahead true-peak limiter held at `ceiling_dbtp` (default -1 dBTP, or -2 dBTP above -14 LUFS). Trims silence at the start and end (`trim`, default true), fades the ring-out (`fade_out_seconds`, default 1; the fade starts only after the sound drops below -40 dBFS, so it never fades the final notes), and writes a dithered WAV (`bit_depth` 24 or 16, default 24) to `Masters/<song>/`. `song` and `label` set the file name. | The master's path, the settings used, `limiter` (`max_reduction_db`, `average_reduction_db_while_limiting`, `percent_of_time_over_1db`), seconds trimmed, measurements of the mix and the master, and `warnings` when the limiting costs punch or the target is out of reach. |
| `release_check` | Checks a file against the release targets: format, sample rate, channels, loudness (against `target_lufs`, else -16 to -9 LUFS), true peak (against `ceiling_dbtp`, else the default ceiling), clipping, true peak after a 256 kbps AAC encode, silence and clicks at the start and end, mono, and loudness range and crest factor against `references` (default: every song in References; an empty list skips it). | `ready`, a one-line `verdict`, `checks` (each `pass`, `warn`, `fail`, or `skipped`, with the measured value, the target, and a plain-words note), `streaming_playback_change_db` (how many dB Spotify, YouTube/Tidal/Amazon, and Apple Music turn the song up or down), the reference measurements, and the full measurement. |

| `master_versions` | Makes other versions of a `master` made by `master_render`. `versions` (default instrumental and stems): `instrumental` (every vocal track muted), `tv_mix` (lead muted, backing vocals kept), `a_cappella` (only vocal tracks), `clean` (each of `clean_spans`, `{start, end}` in song time up to 5 s, silenced on the vocal tracks), and `stems` (groups of tracks alone; `stem_groups` maps a stem name to track names). `vocal_tracks` and `lead_tracks` override the tracks found by name. First renders the mix and stops if it differs from the master's source bounce. Each version gets the master's exact gain, limiter, trim, and fades; stems get only the trim and fades. Puts back every mute, solo, and region edit. Making a version again replaces the earlier file of that version. | `versions` (each `file`, `loudness_lufs`, `true_peak_dbtp`, `limiter`), `stems` (each `stem`, `tracks`, `file`), `stems_add_up_to_mix_within_db`, `clean_spans`, and `notes`. |

`master_render` records each master's settings in a hidden file beside it. A master made before mixtools 0.4 has no settings; render it again to make versions.

The limiter cannot add more than about 12 dB of gain beyond what the loudness difference calls for. Past that point more gain adds distortion, not loudness, so `master_render` stops and reports the loudness it reached.

## Notes for the mixtools team and the self-test

| Tool | Does | Returns |
| --- | --- | --- |
| `feedback_note` | Adds a dated line to `Reports/Notes for the mixtools team.md`: `kind` (`problem`, `struggle`, or `idea`), the `note`, the person's words in `quote`, and the `song`. Stamps the mixtools version. | The notes file and `unsent_notes`: how many notes no report has included yet. |
| `feedback_report` | Writes `Reports/Mixtools report <date time>.md` (a number is added if that name is taken): the `summary`, the mixtools, Ardour, and macOS versions, every note no earlier report included, the `selftest` results (each `step`, `result` of `pass`, `fixed`, `fail`, or `skipped`, and `detail`), and the current status. Marks those notes as reported. `show_in_finder` opens a Finder window with the report selected. Refuses when there is nothing new to report. | `report` (its path), `notes_included`, `selftest_steps`, and `how_to_send`. |
| `selftest_song` | Writes generated stems to `Self-Test Audio/` and makes the song "Mixtools Self-Test" from them: Kick, Snare, Bass, stereo Keys, Lead Vocal (quiet, one "s" sound at the start of each phrase), and Backing Vocals (chorus only); 25 seconds at 120 BPM. First deletes the previous self-test song and its bounces, masters, and archives; refuses if a song by that name was not made by the self-test. If Ardour does not finish opening, it marks the half-made song so the next call replaces it. Needs Ardour closed. Only for the `mixtools-selftest` skill. | The song and its folder, the imported tracks, what it deleted, and `audio`: sections, lead vocal phrase times, and `expected` values for the checks (`moment_time`, `clean_span`, `vocal_tracks`, and what the starting balance and the "s" sound check should find). |

`mixtools_status` also returns `feedback`: `unsent_notes`, `notes_file`, and `reports_folder`.
