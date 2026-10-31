# fgc-mixtools

Mixtools lets Claude act as a mix engineer in Ardour, the open-source recording and mixing app. You describe what you hear in your own words, like "the vocals are buried" or "it sounds muddy". Claude bounces your song, measures it, compares it to songs you like, makes one small change, and plays you the before and after. You decide what stays.

Mixtools never edits your recordings. It saves the mixer settings before every change, so any change can be undone.

## What you need

- A Mac with Apple silicon
- The Claude desktop app
- The mixtools build of Ardour (`Ardour-9.8.0-arm64.dmg`), from whoever gave you mixtools

## Install

1. Open the Claude desktop app.
2. Open **Customize**, go to plugins, and add a marketplace from this link: `https://github.com/fallguyconsulting/fgc-mixtools`
3. Install the **mixtools** plugin.
4. Start a new chat and say: **set up mixtools**

Claude walks you through the rest: installing Ardour, installing the mixtools extension, and a first test.

To install in Claude Code instead:

```
/plugin install mixtools --marketplace fallguyconsulting/fgc-mixtools
```

## Using it

Have one audio file per instrument or voice ready, then tell Claude what you want. For example:

- "Help me mix my song. The files are in my Downloads folder."
- "The vocals are hard to hear in the chorus."
- "It sounds muddy compared to my reference."
- "Make the drums punchier."

## What's in this repository

| Path | What it is |
| --- | --- |
| `.claude-plugin/marketplace.json` | The marketplace catalog. Claude reads it when someone adds this repository as a marketplace. |
| `plugins/mixtools/` | The mixtools plugin. |
| `plugins/mixtools/skills/mix-session/` | The skill that runs a mixing session. Its `references/` folder holds the word map, the Ardour cheat sheet, the loudness targets, and the tool reference. |
| `plugins/mixtools/skills/mixtools-setup/` | The skill that walks a new user through setup. |
| `extension/` | The mixtools desktop extension (`mixtools.mcpb`): a dependency-free Node.js MCP server that drives Ardour and measures audio. |

The extension ships as a GitHub release asset. It needs the mixtools build of Ardour, which adds an audio import tool to Ardour's built-in MCP server and limits that server to connections from the same Mac.

## Developing locally

Validate the manifests and skills:

```
claude plugin validate .
claude plugin validate plugins/mixtools
npx @anthropic-ai/mcpb validate extension/manifest.json
```

Load the plugin into one Claude Code session without installing it, with the extension's server registered:

```
claude --plugin-dir plugins/mixtools
claude mcp add mixtools -- node "$PWD/extension/server/index.js"
```

Build the extension bundle:

```
npx @anthropic-ai/mcpb pack extension mixtools.mcpb
```
