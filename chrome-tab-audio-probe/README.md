# Relay Tab Audio Source

This unpacked Chrome extension is the desktop backing-source bridge for Relay.

It uses `chrome.tabCapture` only after an explicit extension-button click. Chrome gives the offscreen extension document the current tab's rendered audio as a `MediaStream`; the extension converts that stream to mono Int16 PCM and sends it to the Relay WebSocket as role `backing`.

## Use

1. Run Relay on the desktop (`npm run dev`).
2. Open `http://localhost:3000/source.html` in desktop Chrome. If `RELAY_KEY` is set, keep the same `?key=...` query on this URL.
3. Start YouTube on the singer phone so Relay has a live timeline.
4. On the desktop source page, press **Enable source audio** once. The page mirrors the phone video ID / play / pause / seek state.
5. With the source page as the active tab, click the **Relay Tab Audio Source** extension icon.
6. The badge should show changing dBFS values while the YouTube source has audio. Relay receives the same captured PCM and automatically switches Monitor / Solo Record to the 48 kHz live mix path.
7. Click the extension icon again to stop capture and return Relay to the normal raw-microphone path.

The extension intentionally accepts only a local Relay source page (`localhost` or `127.0.0.1`). It does not capture arbitrary tabs or send audio anywhere except that local Relay WebSocket.
