# Chrome tab-audio probe

This is a deliberately tiny feasibility test for one question:

> Can desktop Chrome expose the rendered audio of the current tab as a `MediaStream`, even when that sound comes from an embedded player?

The extension **does not record, save, upload, or relay audio**. It only measures RMS level locally and shows the result in the extension badge.

## Load it

1. Update the Relay branch locally.
2. Open `chrome://extensions` in desktop Chrome.
3. Enable **Developer mode**.
4. Click **Load unpacked** and choose this `chrome-tab-audio-probe/` folder.
5. Pin **Relay Tab Audio Probe** so its badge is visible.

## Test it

1. Open Relay in desktop Chrome and load/play the existing YouTube iframe.
2. While that Relay tab is active, click the **Relay Tab Audio Probe** extension once.
3. The extension badge should change from `…` to a number such as `-24`. That number is approximate dBFS; it should move while audio is playing.
4. Pause the YouTube player. The badge should settle near `--`.
5. Resume playback. The level should return.
6. Click the extension again to stop capture.

Chrome normally removes a captured tab's audio from direct playback. The probe reconnects the captured `MediaStream` to an `AudioContext` output so the tab should remain audible while testing.

## What success means

If the badge follows YouTube audio, the browser-security limitation is narrower than the page-level IFrame limitation: page JavaScript still cannot access YouTube PCM, but a user-authorized Chrome tab capture can access the tab's rendered audio stream.

That does **not** yet prove a fully unattended server is possible. Chrome requires a user invocation before `tabCapture` can start. The next feasibility question would be how much of that browser session can be made persistent/operational on the machine running Relay.
