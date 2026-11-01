---
name: mixtools-selftest
description: Run the mixtools self-test, which makes a test song, runs every mixtools tool on it, fixes what it can, and writes a report for the mixtools team. Use ONLY when the person explicitly asks to run the mixtools self-test ("run the self-test", "test mixtools", "check that everything in mixtools works"). Never start it on your own, and never use it for mixing, setup, or fixing one problem.
---

# Mixtools self-test

The self-test checks every part of mixtools on this Mac. It makes a song named "Mixtools Self-Test" from generated audio, runs every tool on it, fixes what it can, and ends with a report the person sends to the mixtools team. It never opens or changes the person's own songs.

## How to talk to the person

- Before starting, tell them in two sentences what happens: "I'll make a test song called Mixtools Self-Test and try every mixtools feature on it. Your own songs stay untouched; I'll need Ardour closed to start."
- Run the steps without asking between them. Speak only when the person must act (quit Ardour, click a window, say whether they heard sound) or when a step fails.
- Keep a list of results as you go: each step's name, its result (`pass`, `fixed`, `fail`, or `skipped`), and a detail line with what you checked, what you fixed, or the exact error text.

## When a step fails

1. Call `mixtools_status`. If it reports a problem, apply the fix from the `mixtools-setup` skill, then run the step once more.
2. If the step works now, record `fixed` with what you fixed.
3. If it fails again, record `fail` with the exact error text, and also call `feedback_note` with kind `problem`. Go on to the next step. Record `skipped` for a later step that needs a file the failed step should have made.

Never fix a failure by changing the person's songs, deleting their files, or editing mixtools itself.

## Steps

### 1. Tools

Look for the `mixtools_status` tool.

- **Missing:** the extension is not installed. Follow step 2 of the `mixtools-setup` skill, then start the self-test again in a new chat.
- **Present, but `selftest_song` or `feedback_report` is missing:** the extension is older than the plugin. Ask the person to install the latest extension, following step 2 of the `mixtools-setup` skill, then start the self-test again in a new chat.

### 2. Status

Call `mixtools_status`. Fix each problem as the `mixtools-setup` skill describes, calling `mixtools_status` again after each fix. Record `pass` if there were no problems, `fixed` with the problems you fixed, or `fail` with the problems left. Note `mixtools_version` and the Ardour version for the summary.

### 3. Test song

If Ardour is open, ask the person to save their song and quit Ardour (Session menu, then Quit). Then call `selftest_song`. It opens Ardour and can wait up to two minutes for it. Keep the result: its `audio.expected` values drive the checks below.

If `selftest_song` says Ardour did not finish opening, Ardour is probably showing a window, such as audio setup. Ask the person to click **Start** or **OK** in it, then quit Ardour without saving (the **Ardour9** menu, then **Quit**, then **Don't Save**). Then call `selftest_song` again; it replaces the half-made song. If it fails the same way twice, record `fail` and go to step 14.

Pass: the result lists 6 imported tracks. From here on, before each step that changes anything, the open song must be "Mixtools Self-Test". If `mixtools_status` shows another song open, stop the self-test and tell the person.

### 4. Starting balance

Call `mix_starting_balance` with no arguments. Pass: `tracks` has a fader for every track, and Lead Vocal's `level_vs_lead_db` is 0. The generated lead vocal starts quiet and the keys start loud, so Lead Vocal's fader should end up higher than Keys'.

### 5. Snapshots and Ardour tools

1. Call `snapshot_save` with label `self-test before`.
2. Call `ardour_call` with `tracks_list` and find the Keys track's id. Call `ardour_call` with `track_set_fader_db` to set Keys 3 dB lower.
3. Call `snapshot_list`, then `snapshot_restore` with the `self-test before` id.
4. Call `ardour_call` with `track_get_info` for Keys.

Pass: the Keys fader is back where it was before step 2.

### 6. Bounce and measure

1. Call `bounce` with label `self-test` and `stems` ["Lead Vocal", "Keys"].
2. Call `audio_measure` on the mix. Pass: about 25 seconds long, a loudness value, and no `over_full_scale_samples`.
3. Call `audio_compare` with the `raw levels` and `starting balance` bounces from step 4.
4. Call `audio_spectrogram` on the mix from 0 to 8 seconds. Pass: an image comes back.

### 7. Playback

Call `audio_play` on the mix from 8 to 12 seconds, and ask the person whether they heard music. Then call `audio_play` on the same seconds with `simulate` `phone`, then `audio_stop`. Pass: they heard it and both calls returned without error. If they heard nothing, ask them to check the Mac's volume and output, then try once more.

### 8. Moments

1. Call `moment_mark` with time 12 and note `self-test moment`. Pass: a `marker` and `location_id` come back. Tell the person they can see the marker on Ardour's timeline.
2. Call `moment_check` on the step 6 mix at time 12. Pass: `tracks` lists Lead Vocal and Keys, and a `play_window` comes back.

### 9. Vocal and de-esser

1. Call `vocal_sibilance` on the Lead Vocal stem from step 6. Pass: `s_sounds_found` is 12 (11 to 13 is fine), `s_sounds_touched` is above 0, and `touched_outside_s_sounds_seconds` is 0.
2. Call `ardour_call` with `plugin_add_by_plugin_id`, the Lead Vocal track's id, and `deesser.plugin_id` from `mixtools_status`. Then call `plugin_remove` with the `pluginIndex` it returned. Pass: both calls work.

### 10. Master

1. Call `snapshot_save` with label `final mix`, then `bounce` with label `final mix`.
2. Call `master_render` with that bounce as `source` and `target_lufs` -14. Pass: the master's loudness is within 0.5 LU of -14 and its true peak is at or below -1 dBTP.
3. Call `release_check` with the master, `target_lufs` -14, and `references` []. Pass: it returns a verdict. The test song is not a real release, so some checks may warn or fail; record the verdict in the detail line.

### 11. Versions

Call `master_versions` with the master, `versions` ["instrumental", "tv_mix", "a_cappella", "clean", "stems"], and `clean_spans` [`audio.expected.clean_span`] from step 3. Pass: four versions and the stems come back, each with a file.

### 12. Archive

Call `song_archive`. Pass: an `archive` path and a `size_mb` above 0 come back, and `warnings` is empty.

### 13. Mix notes and references

1. Call `journal_write` with log `Self-test ran.`, then `journal_read`. Pass: the log holds that line and the automatic lines for the bounces and the master.
2. Call `reference_list`. Pass: it returns without error. An empty list is fine.

### 14. Report

Call `feedback_report` with:

- `summary`: two or three sentences: the mixtools and Ardour versions, how many steps passed, and the most important failure, if any.
- `selftest`: your list of results, in step order.
- `show_in_finder`: true.

Then tell the person the result in one or two sentences. Always ask them to send the report, because it also tells the team which versions work: "A Finder window shows the report. Please drag it into a message or email to the mixtools team."

### 15. Finish

Tell them the self-test song stays in their song list until the next self-test replaces it, and they can ignore it. Offer to reopen the song they were working on: ask them to quit Ardour, then call `song_open` with that song.
