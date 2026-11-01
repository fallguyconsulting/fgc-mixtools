# Targets

Use these numbers when the person has no reference song, or to sanity-check a reference. A reference song the person likes beats any number in this file.

## While mixing

| Measure | Target | Why |
| --- | --- | --- |
| Sample peak | -6 to -3 dBFS | Leaves room for mastering. |
| True peak | Below 0 dBTP | Above 0 dBTP the mix can distort on playback. |
| Over full scale | No samples | Bounces are float files, so overs show up instead of being cut off. Find the track that causes them and lower it. |
| Stereo correlation | Mostly between 0 and +1 | Below 0 the song loses parts when played in mono, such as on a phone or a smart speaker. |
| Master bus | No limiter or loudness plugin | `master_render` does the limiting on the bounced mix. A limiter during mixing hides balance problems. |

Mix loudness does not matter yet. A good mix is often 6-12 dB quieter than a finished release.

## Mastering for streaming

**Master for sound, not for a loudness number.** Streaming services play every song at about the same level. A master pushed louder than that level gets turned down and gains nothing, and the heavy limiting that made it loud makes it sound flat next to dynamic songs.

### How services play songs

| Service | Plays at | Turns quiet songs up? |
| --- | --- | --- |
| Spotify (default "Normal" setting) | -14 LUFS | Partly. It keeps 1 dB of headroom, so a -20 LUFS song comes up only to about -16 LUFS. |
| YouTube and YouTube Music | -14 LUFS | No |
| Tidal | -14 LUFS, measured per album | No |
| Amazon Music | about -14 LUFS | No |
| Deezer | -15 LUFS | Reported both ways |
| Apple Music (Sound Check, on by default) | about -16 LUFS | Reported both ways |

These figures come from Spotify's published guidance and from mastering guides that measure the others. Apple and Amazon publish no formal numbers.

### Targets for the master

| Measure | Target |
| --- | --- |
| Integrated loudness | -14 to -9 LUFS for most pop, rock, hip-hop, and electronic music. -16 to -11 LUFS for acoustic, folk, and jazz. Let the reference songs decide inside that range. Going louder than -9 rarely helps. |
| True peak | -1 dBTP or lower. -2 dBTP or lower when the master is louder than -14 LUFS. Converting to streaming formats (Ogg, AAC) raises peaks, and peaks above 0 distort. |
| Loudness range | Close to the reference. Far below it means over-compression. |
| Crest factor | Close to the reference. A master much below its reference sounds flat once services turn it down. |
| Over full scale | No samples |

Rough integrated loudness of commercial releases, for context:

| Style | Typical range |
| --- | --- |
| EDM, hip-hop, loud rock and metal | -9 to -6 LUFS |
| Pop | -10 to -7 LUFS |
| Singer-songwriter, folk, jazz | -16 to -11 LUFS |
| Classical, film score | -23 to -16 LUFS |

These ranges describe what people release, not what anyone should aim for.

### Loudness range (LRA) by style

| Style | Typical LRA |
| --- | --- |
| EDM, pop, hip-hop | 3-7 LU |
| Rock, singer-songwriter | 5-10 LU |
| Jazz, classical, film | 10-20 LU |

## Delivery files

`master_render` writes a file that meets the format, start, and end rows. `release_check` checks every row except the listening tests.

| Item | Requirement |
| --- | --- |
| Format | WAV, 24-bit, at the session's sample rate (44.1 or 48 kHz). Use 16-bit with dither only when the distributor or a CD requires it. Never send MP3 or AAC to a distributor. |
| Start | Trim silence before the first sound to a fraction of a second. Keep any intentional count-in or room tone. |
| End | Let the last note ring out, then fade the final second or so to silence so the file ends without a click. |
| Translation | Before calling a master done, check mono (`release_check`'s mono check), compare with a reference at matched loudness, listen through the phone, car, and mono simulations in `audio_play`, and ask the person to listen on their own phone and in their own car. |
| Several songs (EP or album) | Keep the songs' loudness consistent with each other and with how they should feel in sequence. Tidal keeps the relative levels inside an album. |
| Extra versions | Distributors, sync licensing, and remixers often ask for an instrumental, a clean (radio) edit, and stems. Offer to make them with `master_versions` once the main master is approved. Every version must have the same length and timing as the master, and the same mastering; `master_versions` does both. Stems stay at mix level, unlimited, so they add up to the mix. |
