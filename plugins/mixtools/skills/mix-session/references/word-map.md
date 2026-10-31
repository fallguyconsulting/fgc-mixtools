# Word map

People describe sound in everyday words. This table connects those words to what you can measure and the change most likely to help. The frequency ranges are starting points, not rules. Confirm every guess with a measurement before you change anything.

Measure with `audio_measure` (band energies, loudness, peaks, stereo) and `audio_compare` (differences from a reference or an earlier bounce). The bands below match the band names `audio_measure` returns.

| Bands | Range |
| --- | --- |
| sub | 20–60 Hz |
| bass | 60–250 Hz |
| low_mid | 250–500 Hz |
| mid | 500 Hz–2 kHz |
| high_mid | 2–4 kHz |
| presence | 4–6 kHz |
| brilliance | 6–20 kHz |

## Tone

| They say | Check | Likely fix |
| --- | --- | --- |
| muddy, cloudy, thick, blurry | `low_mid` and upper `bass` higher than the reference | Cut 2–3 dB around 200–500 Hz on the tracks that crowd that range (guitars, keys, pads). Add a low cut (high-pass filter) to tracks with no useful low end, such as vocals, guitars, and hi-hats. |
| boomy, bloated, too much bass, rattles the car | `bass` or `sub` higher than the reference | Lower the bass or kick 1–2 dB, or cut a narrow slice where the two overlap. |
| thin, weak, small, no body | `bass` and `low_mid` lower than the reference | Raise 100–250 Hz on the bass, kick, or main instrument by 1–3 dB. Check that a low cut is not set too high. |
| boxy, cardboard, honky, nasal | `low_mid` or `mid` peak in a narrow range | Find the peak with `audio_spectrogram` or stem measurements. Cut 2–3 dB with a narrow EQ band around 300–1000 Hz on the offending track. |
| harsh, shrill, piercing, hurts my ears, tiring | `high_mid` higher than the reference | Cut 1–3 dB around 2–5 kHz on the loudest bright tracks (vocals, guitars, cymbals). |
| hissy "s" sounds, spitty vocal | `presence` and `brilliance` spikes on the vocal stem; bright vertical streaks in `audio_spectrogram` | Cut 2–4 dB with a narrow ACE EQ bell (bandwidth about 0.5) at the frequency of the streaks, usually 5–8 kHz, on the vocal. Ardour has no built-in de-esser. |
| dull, dark, muffled, lifeless, under a blanket | `presence` and `brilliance` lower than the reference | Raise ACE EQ's high shelf (Gain H) 1–2 dB at about 8–10 kHz on the vocal or the main instrument. |

## Balance

| They say | Check | Likely fix |
| --- | --- | --- |
| vocals are buried, can't hear the words | Vocal stem loudness vs. the rest; `high_mid` crowding from guitars or keys | Raise the vocal 1–2 dB. If that makes it sound pasted on, cut 2–3 dB around 2–4 kHz on the competing tracks instead. Light vocal compression keeps quiet words audible. |
| vocal sounds pasted on top, karaoke | Vocal stem much louder than the rest | Lower the vocal 1–2 dB. Add a little of the existing reverb send. |
| kick and bass are fighting, low end is a blur | `bass` and `sub` crowded; kick and bass stems peak in the same range | Cut a narrow slice in the bass where the kick peaks, or the reverse. Lower whichever one the person cares less about. |
| drums have no punch | Drum stem peaks are flat; mix crest factor low | Raise the kick or snare 1–2 dB. If a compressor is on the drums, slow its attack so the hit gets through. |
| a part is too loud or too quiet | Stem loudness | Change that track's volume by 1–2 dB. |
| too much echo, washed out, far away | Reverb and delay send levels | Lower the reverb or delay sends 2–4 dB. |
| too dry, in a closet | Reverb and delay send levels | Raise an existing reverb send 1–3 dB. |

## Loudness and dynamics

| They say | Check | Likely fix |
| --- | --- | --- |
| too quiet compared to other songs | Integrated loudness vs. the reference | During mixing, this is normal. Explain that release loudness is the last step. When they are ready to finish, see `targets.md`. |
| squashed, flat, no life, tiring, loud but small | Crest factor and loudness range lower than the reference | Back off compression or the limiter on the stereo output. |
| distorted, crackles, clicks | Peaks at or above 0 dBFS; true peak above 0 dBTP; clipping count above zero | Find the track or bus that clips with stem measurements. Lower that track's level, not the master fader. |
| quiet parts too quiet, loud parts too loud | Loudness range much higher than the reference | Add light compression on the instrument that swings the most, or ride its level with automation. |

## Space and playback

| They say | Check | Likely fix |
| --- | --- | --- |
| narrow, everything in the middle, small | Stereo width low; correlation near +1 | Pan supporting parts (guitars, keys, backing vocals) left and right. Keep kick, bass, snare, and lead vocal in the center. |
| too wide, hollow, weird on headphones | Correlation near 0 or below | Pull extreme pans in. Check stereo-widening plugins. |
| sounds bad on a phone or laptop speaker | Mono compatibility warning; low `mid` and `high_mid` on the bass stem | Fix mono problems first. Phones play little bass, so a bass that has no upper harmonics disappears. Raise 700 Hz–1.5 kHz on the bass slightly. |
| sounds bad in the car | `bass` and `sub` higher than the reference | Lower the low end 1–2 dB. |
