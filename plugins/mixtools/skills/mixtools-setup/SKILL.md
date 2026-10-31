---
name: mixtools-setup
description: Set up mixtools so Claude can mix Logic Pro songs on this Mac. Use when the person asks to set up, install, or fix mixtools, when the mixtools tools (mixtools_status, logic_bounce, audio_measure, and the rest) are missing, or when mixtools_status reports a problem. The person is not technical; walk them through each click.
---

# Mixtools setup

Get the person from "I installed the plugin" to a working mix session. Do as much as you can yourself with tools. Ask the person to click only where macOS or Claude requires a human.

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

The extension is the part of mixtools that runs on their Mac and talks to Logic Pro. Walk them through this:

1. "Click this link to download the mixtools extension: https://github.com/fallguyconsulting/fgc-mixtools/releases/latest/download/mixtools.mcpb"
2. "Open your Downloads folder and double-click **mixtools.mcpb**." If the Mac asks which app to open it with, tell them to choose **Claude**.
3. "Claude will show an install window. Click **Install**."
4. "Start a new chat and say: set up mixtools." The tools appear only in chats started after the install.

## Step 3: Fix what mixtools_status reports

Call `mixtools_setup` first. It creates the workspace folders and downloads the components it needs. Then call `mixtools_status` again and handle each problem it still reports, in this order.

### Logic Pro is missing

Tell them mixtools needs Logic Pro from the Mac App Store, and stop setup. Mixtools cannot install Logic Pro for them.

### Accessibility permission is off

Mixtools needs Accessibility permission to press buttons and move faders in Logic Pro.

1. Call `mixtools_open_settings` with `page: accessibility`.
2. "System Settings just opened to Accessibility. Find **Claude** in the list and turn its switch on. Your Mac will ask for your password or Touch ID."
3. "If Claude is not in the list, click the **+** button under the list, choose **Claude** from Applications, and click **Open**."
4. Call `mixtools_status` to confirm. If it still reports the permission off, ask them to quit Claude completely (Claude menu, then **Quit Claude**), reopen it, and say "set up mixtools" again. macOS sometimes applies the permission only after a restart.

### Automation permission is off

Mixtools needs Automation permission to tell Logic Pro to save and bounce.

1. Ask them to open Logic Pro if it is not open.
2. Call `logic_project_info`. macOS will show a window asking whether Claude may control Logic Pro. Tell them: "A window just asked if Claude can control Logic Pro. Click **OK**."
3. If they clicked **Don't Allow** earlier, the window will not come back. Call `mixtools_open_settings` with `page: automation` and tell them: "Find **Claude**, open it, and turn on the switch next to **Logic Pro**."
4. Call `mixtools_status` to confirm.

### A component failed to download

Call `mixtools_setup` once more. If it fails again, tell them to check their internet connection. If the internet works, stop and have them send the error text to whoever gave them mixtools.

## Step 4: Add reference songs

Ask: "What one or two songs would you like your song to sound like?" Then: "Drag those song files into the **References** folder." Give the path from `mixtools_status`.

Reference songs are optional. They make the advice much better. Song files from the Music app or a download work. Streaming-only songs from Spotify or Apple Music cannot be copied, so skip those.

## Step 5: Test the loop

1. Ask them to open a song in Logic Pro.
2. Call `logic_project_info` and say the song name back.
3. Call `snapshot_save` with label `setup test`.
4. Call `logic_bounce` with label `setup test`.
5. Call `audio_measure` on the bounce.
6. Call `audio_play` on the first 10 seconds of the bounce and ask if they heard it.

If all six work, tell them setup is done and ask what they would like to change about their song. Then follow the `mix-session` skill.
