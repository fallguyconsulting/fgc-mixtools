# Mixtools tools

The mixtools desktop extension runs on the person's Mac and provides these tools. It drives Ardour through Ardour's built-in MCP server, which listens on this Mac only.

The workspace folder is `~/Music/Mixtools/`:

| Folder | What goes there |
| --- | --- |
| `Songs/<song>/` | One Ardour session per song, made by `song_new`. |
| `References/` | Songs the person wants their mix to sound like. The person adds these. |
| `Bounces/<song>/` | Every bounce, numbered in order: `001-start.wav`, `002-vocal-up.wav`, with stems beside them. |
| `Masters/<song>/` | Release masters made by `master_render`: `<song> (master -14 LUFS).wav`. These are the files to upload. |

## Setup and songs

| Tool | Does | Returns |
| --- | --- | --- |
| `mixtools_status` | Checks Ardour, its MCP server, the open song, and the workspace. | Ardour version and state, the open song, folders, and a list of problems, each with its fix. |
| `mixtools_setup` | Creates the workspace folders and turns on Ardour's MCP server. The second part needs Ardour closed. Safe to run again. | What changed, and a fresh status. |
| `song_new` | Creates a session in `Songs/`, opens it in Ardour, and imports `files` as one track each, named by `track_names`. Needs Ardour closed. | Song folder and the created tracks. |
| `song_open` | Opens a song. With no `path`, lists the songs instead. | Session info, or the song list. |

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
| `audio_play` | Plays a file, or `start` to `end` seconds of it, on the Mac's speakers or headphones. | Confirmation. |
| `audio_stop` | Stops playback. | Confirmation. |
| `reference_list` | Lists the references folder. | Each file's length and loudness. |

Bounces are float files, so a mix that goes over full scale shows its true level instead of being cut off. `over_full_scale_samples` counts those samples. A finished release must have none.

## Mastering

| Tool | Does | Returns |
| --- | --- | --- |
| `master_render` | Masters a mix bounce (`source`) without touching the Ardour session. Raises it to `target_lufs` with a lookahead true-peak limiter held at `ceiling_dbtp` (default -1 dBTP, or -2 dBTP above -14 LUFS). Trims silence at the start and end (`trim`, default true), fades the ring-out (`fade_out_seconds`, default 1; the fade starts only after the sound drops below -40 dBFS, so it never fades the final notes), and writes a dithered WAV (`bit_depth` 24 or 16, default 24) to `Masters/<song>/`. `song` and `label` set the file name. | The master's path, the settings used, `limiter` (`max_reduction_db`, `average_reduction_db_while_limiting`, `percent_of_time_over_1db`), seconds trimmed, measurements of the mix and the master, and `warnings` when the limiting costs punch or the target is out of reach. |
| `release_check` | Checks a file against the release targets: format, sample rate, channels, loudness (against `target_lufs`, else -16 to -9 LUFS), true peak (against `ceiling_dbtp`, else the default ceiling), clipping, true peak after a 256 kbps AAC encode, silence and clicks at the start and end, mono, and loudness range and crest factor against `references` (default: every song in References; an empty list skips it). | `ready`, a one-line `verdict`, `checks` (each `pass`, `warn`, `fail`, or `skipped`, with the measured value, the target, and a plain-words note), `streaming_playback_change_db` (how many dB Spotify, YouTube/Tidal/Amazon, and Apple Music turn the song up or down), the reference measurements, and the full measurement. |

The limiter cannot add more than about 12 dB of gain beyond what the loudness difference calls for. Past that point more gain adds distortion, not loudness, so `master_render` stops and reports the loudness it reached.
