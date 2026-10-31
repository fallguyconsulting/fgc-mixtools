---
name: mixtools-setup
description: Set up mixtools so Claude can mix songs in Ardour on this Mac. Use when the person asks to set up, install, or fix mixtools, when the mixtools tools (mixtools_status, song_new, bounce, audio_measure, and the rest) are missing, or when mixtools_status reports a problem. The person is not technical; walk them through each click.
---

# Mixtools setup

Get the person from "I installed the plugin" to a working mix session. Do as much as you can yourself with tools. Ask the person to click only where macOS, Ardour, or Claude requires a human.

## How to talk to the person

- Give one step at a time. Wait for them to say it worked before the next step.
- Name exactly what to click, using the words they will see on screen.
- After each step, check the result yourself with a tool when one exists. Do not ask them to confirm what you can check.
- If a step fails twice, stop and tell them plainly what is wrong and what to send to whoever gave them mixtools.

## Step 1: Check for the extension

Look for the `mixtools_status` tool.

- **Tool exists:** call it and go to step 3.
- **Tool missing:** go to step 2.

If the person is in a Cowork session and the tool is missing, ask them to start a regular chat instead and say "set up mixtools" there. Desktop extensions may not reach Cowork sessions.

## Step 2: Install the extension

The extension is the part of mixtools that runs on their Mac and talks to Ardour. Walk them through this:

1. "Click this link to download the mixtools extension: https://github.com/fallguyconsulting/fgc-mixtools/releases/latest/download/mixtools.mcpb"
2. "Open your Downloads folder and double-click **mixtools.mcpb**." If the Mac asks which app to open it with, tell them to choose **Claude**.
3. "Claude will show an install window. Click **Install**."
4. "Start a new chat and say: set up mixtools." The tools appear only in chats started after the install.

## Step 3: Fix what mixtools_status reports

Handle each problem in this order. Call `mixtools_status` again after each fix.

### Ardour is not installed

Mixtools needs the Ardour build that came with mixtools. The standard Ardour download lacks the import tool mixtools uses. Ask whether they received a file named like **Ardour-9.8.0-arm64.dmg**.

1. "Double-click **Ardour-9.8.0-arm64.dmg**. A window opens with Ardour9 and an Applications folder."
2. "Drag **Ardour9** onto **Applications**."
3. "Close that window, then right-click the Ardour disk on your desktop or in the Finder sidebar and choose **Eject**."

If they don't have the file, stop and tell them to ask whoever gave them mixtools for it.

### Ardour has never been opened

Ardour shows a few questions the first time it opens. They must answer those once.

1. "Open **Ardour9** from your Applications folder."
2. "Ardour asks a few first-time questions. Click **Next** or **OK** to accept the suggested answers each time."
3. "When it asks to make or open a session, close that window and quit Ardour from the **Ardour9** menu, then **Quit**."

Then call `mixtools_setup`.

### Ardour's MCP server is off, or the workspace folders are missing

Call `mixtools_setup`. If it reports that Ardour is open, ask them to quit Ardour (the **Ardour9** menu, then **Quit**; click **Don't Save** if asked about a session you made in setup), then call `mixtools_setup` again.

### This Ardour cannot import audio

They have a standard Ardour, not the mixtools build. Ask them to quit Ardour, drag **Ardour9** from Applications to the Trash, and install the mixtools build as described above.

## Step 4: Add reference songs

Ask: "What one or two songs would you like your song to sound like?" Then: "Drag those song files into the **References** folder." Give the path from `mixtools_status`, and offer to open it: they can paste the path into Finder's **Go** menu, then **Go to Folder**.

Reference songs are optional. They make the advice much better. Song files from the Music app or a download work. Streaming-only songs from Spotify or Apple Music cannot be copied, so skip those.

## Step 5: Test the loop

1. Ask where their recordings are. They need one audio file per instrument or voice (WAV, AIFF, MP3, M4A, or FLAC). If they only have a single finished stereo file, that works too; it becomes one track.
2. Call `song_new` with a song name and the files. Ardour opens and the tracks appear. If Ardour shows an audio setup window, ask them to click **Start**.
3. Call `snapshot_save` with label `setup test`.
4. Call `bounce` with label `setup test`.
5. Call `audio_measure` on the bounce.
6. Call `audio_play` on the first 10 seconds of the bounce and ask if they heard it.

If all of these work, tell them setup is done and ask what they would like to change about their song. Then follow the `mix-session` skill.
