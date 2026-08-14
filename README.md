# Relay

Experimental low-latency audio relay for a future browser-to-Discord karaoke flow.

## Current milestone

The prototype now verifies two stages:

```text
phone browser microphone -> WebSocket relay -> computer browser monitor
```

and a controlled timing test:

```text
phone local 120 BPM click -> singer
                              |
                              v
phone microphone -> server buffer -> mic gain / voice offset --+
                                                             +--> server mix -> computer monitor
server 120 BPM click ----------------------------------------+
```

Discord, YouTube, real backing tracks, and persistence are still intentionally excluded.

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

## Sync test

1. Use headphones on the phone so its local click does not bleed straight back into the microphone.
2. Start **Monitor** on the computer.
3. Start **Microphone** on the phone.
4. Leave **Mic gain** near `+30 dB` for the current phone if that is the level that sounded normal during raw monitoring.
5. Press **Start test** on the phone. The phone plays a local 120 BPM click. The server independently generates the same click and waits behind an 800 ms safety buffer.
6. Clap or say `搭` exactly on the phone click.
7. Listen on the computer. If the voice arrives after the server click, move **Voice offset** negative. If the voice arrives before it, move the offset positive.
8. Keep changing the offset while the test runs; the server reads from buffered microphone history so the relative timing changes immediately.

The computer monitor automatically returns to 0 dB master gain during the mixed test because the microphone channel now has its own gain control.

## What this proves

- mobile browser microphone capture
- binary PCM transport over WebSocket
- handling different browser audio sample rates
- bounded live buffering instead of ever-growing latency
- server-side microphone gain
- server-side backing generation and PCM mixing
- live relative voice offset across a +/- 500 ms window

## Next milestone

If one offset stays convincing for a few minutes, replace the phone click with YouTube iframe monitoring and replace the server click with a real controlled backing track. That test will tell us whether the YouTube-to-server offset is stable enough for the karaoke design before Discord output is added.
