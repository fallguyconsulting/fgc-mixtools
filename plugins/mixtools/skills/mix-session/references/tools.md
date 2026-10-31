# Mixtools tools

The mixtools desktop extension runs on the person's Mac and provides these tools. They work on the song open in Logic Pro and on audio files in the mixtools workspace folder.

The workspace folder is `~/Music/Mixtools/`. It holds:

| Folder | What goes there |
| --- | --- |
| `References/` | Songs the person wants their mix to sound like. The person adds these. |
| `Bounces/<project>/` | Every bounce, named with a number and a label so before and after stay in order. |
| `Snapshots/<project>/` | Saved copies of the Logic project, one per change. |

## Setup and status

| Tool | Does | Returns |
| --- | --- | --- |
| `mixtools_status` | Checks everything the mix loop needs. | Extension version; Logic Pro installed, version, running; Accessibility and Automation permissions; workspace folder path; downloaded components; a list of problems, each with the fix. |
| `mixtools_setup` | Creates the workspace folders and downloads any missing components from the fgc-mixtools GitHub releases. Safe to run again. | What it created or downloaded, and anything that failed. |
| `mixtools_open_settings` | Opens a System Settings page. Takes `page`: `accessibility` or `automation`. | Confirmation that the page opened. |

## Logic Pro

| Tool | Does | Returns |
| --- | --- | --- |
| `logic_project_info` | Reads the open project. | Project name, file path, tempo, length, sample rate, whether it has unsaved changes. |
| `logic_mixer_read` | Reads every channel strip. | Per track: name, type, volume (dB), pan, mute, solo, sends and their levels, output, plugins in order with bypass state. |
| `logic_set` | Changes one channel strip setting. Takes `track`, `setting` (`volume`, `pan`, `mute`, `solo`, or `send:<n>`), and `value`. | The old value and the new value, read back from Logic Pro. |
| `logic_plugin_read` | Reads one plugin's parameters. Takes `track` and `plugin` (name or slot). | Parameter names, values, and ranges. |
| `logic_plugin_set` | Changes one plugin parameter. Takes `track`, `plugin`, `parameter`, and `value`. | The old value and the new value, read back from Logic Pro. |
| `logic_bounce` | Bounces the song to the workspace. Takes `label`, and optional `tracks` for stems and `range` (bars or seconds). | Paths of the bounced files. |

## Snapshots

| Tool | Does | Returns |
| --- | --- | --- |
| `snapshot_save` | Saves the project and copies it to the snapshots folder. Takes `label`. | Snapshot id, label, time. |
| `snapshot_list` | Lists snapshots for the open project. | Id, label, and time for each. |
| `snapshot_restore` | Closes the project and reopens the chosen snapshot as the working project. Saves a snapshot of the current state first, so restoring is itself undoable. Takes `id`. | The restored snapshot, and the id of the safety snapshot. |

## Audio

| Tool | Does | Returns |
| --- | --- | --- |
| `audio_measure` | Measures one audio file. Takes `path` and optional `range`. | Integrated loudness (LUFS), loudness range (LU), sample peak (dBFS), true peak (dBTP), crest factor, clipping count, stereo correlation and width, mono compatibility warning, energy per band (`sub`, `bass`, `low_mid`, `mid`, `high_mid`, `presence`, `brilliance`). |
| `audio_compare` | Measures two files and reports the differences. Takes `a`, `b`, and `match_loudness` (default true, so tone differences are not hidden by level differences). | Each measurement for both files and the difference, plus the largest differences in plain words. |
| `audio_spectrogram` | Draws a spectrogram image of a file. Takes `path` and optional `range`. | A PNG image: time left to right, frequency bottom to top, brightness as energy. |
| `reference_list` | Lists songs in the references folder. | File names, lengths, and loudness. |
| `audio_play` | Plays a file through the Mac's speakers or headphones. Takes `path` and optional `range`. Stops anything already playing. | Confirmation. |
| `audio_stop` | Stops playback. | Confirmation. |
