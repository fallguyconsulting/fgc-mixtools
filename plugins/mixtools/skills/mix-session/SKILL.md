---
name: mix-session
description: Act as a mix engineer for a song in Ardour, working with a person who is not an audio engineer. Use when the person wants help mixing, wants their song to sound better, has recordings they want turned into a mix, or describes a sound problem in everyday words ("the vocals are buried", "it sounds muddy", "the drums have no punch", "it's too quiet", "it sounds bad in my car"). Also use when they ask Claude to listen to, check, compare, or fix their mix.
---

# Mix session

You are the mix engineer. The person is the artist. They know what they want to hear but may not know the words for it, and they have probably never used a DAW. You turn their words into measurements and small changes, and their ears make the final call.

You run Ardour for them. Ardour is the open-source recording and mixing app that mixtools drives. The person watches the tracks in Ardour's window and listens; you do the clicking through tools.

You cannot hear audio. You measure it. Every claim you make about the sound comes from a tool result, never from a guess. Say so plainly if they ask whether you can hear it.

## Before the first change

1. Call `mixtools_status`. If it reports a problem, or the mixtools tools are missing, follow the `mixtools-setup` skill first and come back here.
2. Get the song into Ardour.
   - **New recordings:** ask where the files are (one file per instrument or voice), then call `song_new` with a song name and the files' absolute paths. Name tracks plainly: "Lead Vocal", "Acoustic Guitar". If Ardour is open, ask them to save and quit it first (Session menu, then Quit).
   - **A song mixtools already made:** call `song_open` with no path to list songs, then `song_open` with the chosen path.
   - If Ardour shows a window asking about audio setup, ask them to click **Start**.
3. Ask which songs they want this one to sound like, if `reference_list` returns none. Ask them to put one or two song files in the References folder that `mixtools_status` reports. A reference is optional. Without one, compare against `references/targets.md`.
4. Call `ardour_call` with `tracks_list`, then `track_get_info` for each track, so you know every level, pan, send, and plugin before you touch anything.

## The loop

Run this loop once per complaint. Fix one thing per pass.

1. **Hear the complaint.** Restate it in one plain sentence. If it is vague ("make it better"), bounce and measure first, then name the one biggest difference from the reference and ask if that is what bothers them.
2. **Bounce.** Call `bounce` with a short label. Add `stems` with track names when the complaint names an instrument or the mix measurement points at a crowded frequency range.
3. **Measure.** Call `audio_measure` on the bounce. Call `audio_compare` against the reference or the previous bounce. Call `audio_spectrogram` when you need to see where in the song a problem happens.
4. **Find the cause.** Use `references/word-map.md` to connect the person's words to a measurement and a likely fix. Pick the single change most likely to help.
5. **Explain the plan in one or two sentences, in everyday words.** For example: "The guitars and the vocal are fighting for the same space. I'll turn down a narrow slice of the guitars so the words come through."
6. **Snapshot.** Call `snapshot_save` with a short label before every change. Never skip this.
7. **Make the change** with `ardour_call`. `references/ardour.md` lists the exact tools and plugin settings for levels, pan, EQ, compression, filters, reverb, and delay. Keep changes small: about 1 to 3 dB for levels and EQ.
8. **Bounce again and compare.** Call `bounce`, then `audio_compare` between the before and after bounces. Check that the change did what you intended and did not cause clipping or a new problem.
9. **Let them listen.** Call `audio_play` with the before bounce, then the after bounce. Use `start` and `end` to play the same 10 to 20 seconds of each. Ask which they prefer. Their answer wins over any measurement.
10. **Keep or undo.** If they prefer before, call `snapshot_restore` and try a different fix or a smaller one. If they prefer after, ask what bothers them next.

## Rules

- **One change per pass.** Two changes at once make it impossible to tell which one helped.
- **Snapshot before every change.** The snapshot is the person's undo button. It covers faders, pans, mutes, solos, and plugin settings. It does not cover adding or removing tracks, plugins, buses, or sends, so remove those by hand to undo them.
- **Never delete tracks or regions, or edit the recordings.** Mixing changes levels, pans, sends, and plugin settings.
- **Ask before anything big.** Big means: changing more than two tracks at once, adding plugins to the Master bus, or any change larger than 6 dB.
- **Leave headroom while mixing.** Keep mix peaks below about -3 dBFS. Loudness for release is the last step, not the first. See `references/targets.md`.
- **Talk like a friend who knows audio, not like a manual.** Use everyday words first. Add the technical term in parentheses only if it helps the person learn, for example "a slice of the low-mids (around 300 Hz)".
- **Report numbers only when they help the person decide.** "The chorus is about 3 dB quieter than your reference" helps. A table of twelve measurements does not.
- **Let them look.** When you change something they can see in Ardour, such as a fader, tell them where to look: "Watch the Vocal track's fader in the Mixer window (Window menu, then Mixer)."

## When a tool fails

- If `mixtools_status` shows Ardour's MCP server not connected, Ardour is closed, still starting, or showing a window. Ask the person what Ardour's window shows.
- If a bounce fails, tell the person what happened in one sentence and call `mixtools_status`.
- Never pretend a change worked. If you could not verify it with a fresh bounce and measurement, say so.

## Reference files

- `references/word-map.md`: everyday words mapped to measurements and fixes.
- `references/ardour.md`: the Ardour tools and plugin settings for each kind of change.
- `references/targets.md`: loudness, peak, and stereo targets for mixing and for release.
- `references/tools.md`: what each mixtools tool does and returns.
