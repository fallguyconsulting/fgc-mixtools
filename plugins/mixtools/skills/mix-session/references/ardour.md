# Ardour cheat sheet

Make every change with `ardour_call`, passing the Ardour tool's `name` and `arguments`. Call `ardour_tools` with a `name` to see any tool's full schema, or with a `filter` to search.

Ardour identifies tracks by `id`, a string such as `"429"`. Get ids from `tracks_list`. Names can repeat; ids cannot.

## Reading the mixer

| Need | Tool | Arguments |
| --- | --- | --- |
| All tracks | `tracks_list` | none |
| One track's fader, pan, mute, solo, sends, plugins | `track_get_info` | `id` |
| One plugin's parameters | `plugin_get_description` | `id`, `pluginIndex` |

`plugin_get_description` returns `parameters`, each with `index`, `label`, `lower`, `upper`, and `currentValue`.

## Levels, pan, mute

| Change | Tool | Arguments |
| --- | --- | --- |
| Track level | `track_set_fader_db` | `id`, `db` (-193 to +6) |
| Pan | `track_set_pan` | `id`, `position` |
| Mute | `track_set_mute` | `id`, `value` (true/false) |

**Pan positions run backwards from what you might expect:** 0.0 is hard right, 0.5 is center, 1.0 is hard left. For a part panned slightly left, use about 0.65. For slightly right, about 0.35.

## Plugins

Add a plugin with `plugin_add_by_plugin_id` (`id`, `pluginId`). It goes before the fader and returns its `pluginIndex`. Set a parameter with `plugin_set_parameter_by_index_value` (`id`, `pluginIndex`, `parameterIndex`, `value`). Bypass with `plugin_set_enabled`. Remove with `plugin_remove`.

Use Ardour's built-in plugins. They are always installed.

### ACE EQ — `lv2:urn:ardour:a-eq`

Six bands: a low shelf, four bell bands, and a high shelf.

| Index | Parameter | Range | Default |
| --- | --- | --- | --- |
| 0 | Frequency L (low shelf) | 20-20000 Hz | 160 |
| 1 | Gain L | -20 to +20 dB | 0 |
| 2, 5, 8, 11 | Frequency 1, 2, 3, 4 | 20-20000 Hz | 300, 1000, 2500, 6000 |
| 3, 6, 9, 12 | Gain 1, 2, 3, 4 | -20 to +20 dB | 0 |
| 4, 7, 10, 13 | Bandwidth 1, 2, 3, 4 (octaves; smaller is narrower) | 0.1-4 | 1 |
| 14 | Frequency H (high shelf) | 20-20000 Hz | 9000 |
| 15 | Gain H | -20 to +20 dB | 0 |
| 16 | Master Gain | -20 to +20 dB | 0 |

For a narrow cut, use a bandwidth of about 0.5. For a gentle broad change, use 1 to 2.

### ACE High/Low Pass Filter — `lua:cbf2433c611d0849cbb198719a5ad05d2f69d24a`

Use it to remove low rumble from tracks that need no deep bass: vocals, guitars, keys, hi-hats.

| Index | Parameter | Range | Default |
| --- | --- | --- | --- |
| 0 | High Pass Steepness | 0=12, 1=24, 2=36, 3=48 dB/oct, 4=off | 1 |
| 1 | High Pass Cut off frequency | 5-20000 Hz | 100 |
| 3 | Low Pass Steepness | same as index 0 | 1 |
| 4 | Low Pass Cut off frequency | 20-20000 Hz | 18000 |

Typical high-pass settings: vocals 80-100 Hz, guitars 80-120 Hz, keys and pads 100-150 Hz.

### ACE Compressor — `lv2:urn:ardour:a-comp` (mono), `lv2:urn:ardour:a-comp#stereo` (stereo)

Use the mono version on mono tracks and the stereo version on stereo tracks and buses.

| Index | Parameter | Range | Default |
| --- | --- | --- | --- |
| 0 | Attack | 0.1-100 ms | 10 |
| 1 | Release | 1-2000 ms | 80 |
| 2 | Knee | 0-8 dB | 0 |
| 3 | Ratio | 1-20 | 4 |
| 4 | Threshold | -60 to 0 dB | 0 |
| 5 | Makeup | 0-30 dB | 0 |

At the default threshold of 0 dB it does almost nothing. Starting points: a vocal at ratio 3, threshold about 10 dB below the track's loud parts, attack 10 ms, release 100 ms, then makeup gain to match the old level. For drum punch, a slower attack (20-30 ms) lets the hit through before the compressor reacts.

### Reverb and delay on a bus

Put reverb on its own bus and send tracks to it. That way one reverb serves many tracks, and each track's send level sets how much reverb it gets.

1. `buses_add` with `type: "audio"`, `name: "Reverb"`, `count: 1`. Get the bus id from `tracks_list`.
2. `plugin_add_by_plugin_id` on the bus with `lv2:urn:ardour:a-reverb`. Set parameter 0 (Blend) to 1.0 so the bus carries only reverb. Parameter 1 (Room Size, 0.5-1) sets the space.
3. `track_add_send` with the track's `id`, `targetId` (the bus id), and `db` (start around -15).
4. Adjust with `track_set_send_level_db` (`id`, `sendIndex`, `db`). `track_get_info` lists each track's sends in order.

ACE Delay (`lv2:urn:ardour:a-delay`) works the same way on a "Delay" bus: set index 4 (Dry/Wet) to 100, index 2 (Time) in ms, index 5 (Feedback) 15-30%, index 6 (LPF) around 4000 Hz to keep repeats soft.

A new bus or send is not covered by snapshots. Remove it with `track_remove_send` or by deleting the bus if the person prefers the mix without it.

## Playback in Ardour

`transport_play`, `transport_stop`, and `transport_locate_sample` (`sample`) move Ardour's own playhead. Use them when the person wants to hear Ardour's live mix. Use `audio_play` for before/after bounces.

## Undo

`snapshot_save` and `snapshot_restore` are the undo for mixer settings. Ardour's own `session_undo` undoes editing operations such as region moves, not fader or plugin changes.
