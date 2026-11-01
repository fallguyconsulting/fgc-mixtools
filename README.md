# fgc-mixtools

Mixtools lets Claude act as a mix engineer in Ardour, the open-source recording and mixing app. You describe what you hear in your own words, like "the vocals are buried" or "it sounds muddy". When you bring in new recordings, Claude first sets every track's volume so nothing starts buried or too loud. Then it bounces your song, measures it, compares it to songs you like, makes one small change, and plays you the before and after. Point at a moment, like "at 1:23 the vocal disappears", and Claude marks it in Ardour, finds what covers the vocal there, and fixes just that spot. You decide what stays. When the mix is done, Claude renders a master for streaming services and checks it is ready to upload. It can also make an instrumental, a clean edit, and stems that match the master, and zip the whole song for backup. Claude keeps notes for each song, so the next conversation picks up where the last one stopped.

Mixtools never edits your recordings. It saves the mixer settings before every change, so any change can be undone.

## What you need

- A Mac with macOS 11 or later, with Apple silicon or an Intel processor
- The Claude desktop app
- The mixtools build of Ardour (`Ardour-9.8.0-universal.dmg`), from whoever gave you mixtools

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

## If something seems broken

Start a new chat and say: **run the mixtools self-test**

Claude makes a test song called "Mixtools Self-Test" from generated audio and tries every mixtools feature on it. Your own songs stay untouched. Claude fixes what it can, then writes a report and shows it in a Finder window. Drag the report into a message or email to whoever gave you mixtools.

## Problems and ideas

You don't need a GitHub account to report a problem or suggest an idea. While you work, Claude notes anything that breaks, anything that confuses you, and anything mixtools could do better. It adds these notes to `~/Music/Mixtools/Reports/Notes for the mixtools team.md`. When you finish, Claude offers to turn them into a report. Send the report to whoever gave you mixtools, the same way as a self-test report.

## What's in this repository

| Path | What it is |
| --- | --- |
| `.claude-plugin/marketplace.json` | The marketplace catalog. Claude reads it when someone adds this repository as a marketplace. |
| `plugins/mixtools/` | The mixtools plugin. |
| `plugins/mixtools/skills/mix-session/` | The skill that runs a mixing session. Its `references/` folder holds the word map, the Ardour cheat sheet, the loudness targets, and the tool reference. |
| `plugins/mixtools/skills/mixtools-setup/` | The skill that walks a new user through setup. |
| `plugins/mixtools/skills/mixtools-selftest/` | The self-test skill. It runs only when someone asks for the self-test by name. |
| `extension/` | The mixtools desktop extension (`mixtools.mcpb`): a dependency-free Node.js MCP server that drives Ardour and measures audio. |
| `ardour/` | The script that builds the mixtools build of Ardour, and our patch to Ardour's source. |

The extension ships as a GitHub release asset. It needs the mixtools build of Ardour, which adds an audio import tool to Ardour's built-in MCP server and limits that server to connections from the same Mac.

## Building Ardour

`ardour/build-ardour.sh` downloads Ardour 9.8's source into `ardour/src/`, applies the patches in `ardour/patches/`, builds it, and writes a signed disk image to `ardour/dist/`. It builds Ardour's libraries with Ardour's own recipe into `ardour/stack/`, for Apple silicon and for Intel (under Rosetta), then merges the two builds into one universal app that runs on macOS 11 or later. Git ignores all four output folders. The script's header lists the options.

```
SIGN_IDENTITY="Developer ID Application: Fall Guy LLC (J4R9FTUGW2)" \
NOTARY_PROFILE=mixtools-notary \
ardour/build-ardour.sh
```

With `NOTARY_PROFILE` set, the script has Apple notarize the disk image, so macOS opens it on any Mac without a warning. Make the profile once with `xcrun notarytool store-credentials mixtools-notary --apple-id <Apple ID> --team-id J4R9FTUGW2`. Share the disk image only inside the organization; the release does not publish it.

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
