# fgc-mixtools

Mixtools lets Claude act as a mix engineer for Logic Pro. You describe what you hear in your own words, like "the vocals are buried" or "it sounds muddy". Claude bounces your song, measures it, compares it to songs you like, makes one small change, and plays you the before and after. You decide what stays.

Mixtools never edits your recordings. It saves a copy of your project before every change, so any change can be undone.

## What you need

- A Mac with Logic Pro from the Mac App Store
- The Claude desktop app

## Install

1. Open the Claude desktop app.
2. Open **Customize**, go to plugins, and add a marketplace from this link: `https://github.com/fallguyconsulting/fgc-mixtools`
3. Install the **mixtools** plugin.
4. Start a new chat and say: **set up mixtools**

Claude walks you through the rest. You will download one file and turn on two switches in System Settings.

## Using it

Open your song in Logic Pro, then tell Claude what you want to change. For example:

- "Help me mix this song."
- "The vocals are hard to hear in the chorus."
- "It sounds muddy compared to my reference."
- "Make the drums punchier."

## What's in this repository

| Path | What it is |
| --- | --- |
| `.claude-plugin/marketplace.json` | The marketplace catalog. Claude reads it when someone adds this repository as a marketplace. |
| `plugins/mixtools/` | The mixtools plugin. |
| `plugins/mixtools/skills/mix-session/` | The skill that runs a mixing session. Its `references/` folder holds the word map, the loudness targets, and the tool reference. |
| `plugins/mixtools/skills/mixtools-setup/` | The skill that walks a new user through setup. |

The desktop extension (`mixtools.mcpb`) ships as a GitHub release asset. `plugins/mixtools/skills/mix-session/references/tools.md` defines the tools it provides.

To install in Claude Code instead:

```
/plugin install mixtools --marketplace fallguyconsulting/fgc-mixtools
```

## Developing locally

Validate the manifests and skills:

```
claude plugin validate .
claude plugin validate plugins/mixtools
```

Load the plugin into one Claude Code session without installing it:

```
claude --plugin-dir plugins/mixtools
```
