# Relay

Experimental low-latency audio relay for a future browser-to-Discord karaoke flow.

## Current milestone

The first prototype intentionally excludes Discord, YouTube, and mixing. It only verifies this path:

```text
phone browser microphone -> WebSocket relay -> computer browser monitor
```

The microphone is captured as mono PCM, sent in roughly 20 ms chunks, buffered briefly on the monitor, and played through the computer browser.

## Run

Requires Node.js 20.19 or newer.

```bash
npm install
npm run dev
```

Open `http://localhost:3000` on the computer and choose **Monitor**.

For a phone, microphone capture requires a secure context. During development, expose the local HTTP server through an HTTPS tunnel, open that HTTPS URL on the phone, and choose **Microphone**.

If the tunnel is public, set an optional shared key before starting the server:

```bash
RELAY_KEY=some-random-string npm run dev
```

Then open the page with `?key=some-random-string`. The WebSocket upgrade is rejected when the key does not match.

## What this proves

- mobile browser microphone capture
- binary PCM transport over WebSocket
- handling different browser audio sample rates
- a small playback jitter buffer
- computer-side live monitoring

## Next milestone

Once this path is stable, add a server-side backing track and controllable timing offset before introducing YouTube monitoring or Discord output.
