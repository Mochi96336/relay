# Relay

Experimental low-latency audio relay for a future browser-to-Discord karaoke flow.

## Current milestone

The prototype now has three independent pieces:

```text
phone browser microphone -> WebSocket relay -> computer monitor / recorder
```

```text
phone visible YouTube IFrame -> local listening + local timeline telemetry
```

and the older controlled click mixer:

```text
phone local 120 BPM click -> singer
                              |
                              v
phone microphone -> server buffer -> mic gain / voice offset --+
                                                             +--> server mix -> computer monitor
server 120 BPM click ----------------------------------------+
```

Discord and real server-side backing tracks are still intentionally excluded.

## Run

Requires Node.js 20.19 or newer.

```bash
npm install
npm run dev
```

Open `http://localhost:3000` on the computer.

For a phone, microphone capture requires a secure context. During development, expose the local HTTP server through an HTTPS tunnel, open that HTTPS URL on the phone, and choose **Microphone**.

If the tunnel is public, set an optional shared key before starting the server:

```bash
RELAY_KEY=some-random-string npm run dev
```

Then open the page with `?key=some-random-string`. The audio WebSocket upgrade is rejected when the key does not match.

## YouTube monitor experiment

The YouTube integration deliberately uses the official visible IFrame Player API only.

1. On the phone, paste a YouTube URL or 11-character video ID and press **Load**.
2. Start playback from the normal controls inside the visible YouTube player.
3. Press **Microphone** and confirm the YouTube playback keeps running while microphone PCM still reaches Relay.
4. Try the reverse order once: start **Microphone** first, then start YouTube playback.
5. Watch the local readout for player state, `getCurrentTime()`, duration, playback rate, buffering, and obvious timeline jumps.
6. On the computer, use **Record** if you want to confirm microphone transport stayed alive while YouTube was playing on the phone.

The YouTube module emits local telemetry every 250 ms. A separate WebSocket client forwards that telemetry to Relay without sharing the microphone PCM path.

Relay maintains a free-running server media timeline. Play, pause, buffering, rate, and video changes create normal re-anchors. Seek/discontinuity jumps are counted separately as corrections. Seek detection checks media continuity across YouTube state changes because scrubbing commonly passes through `buffering` before returning to `playing`.

Drift measurement does not align browser and server wall clocks. It compares YouTube media-time progression against server monotonic receive-time progression over a rolling window. RTT is used only as an approximate transport estimate for the displayed phase and is not part of drift measurement. The UI also reports measurement jitter.

Important boundary: YouTube audio is not extracted, downloaded, separated, or sent to the Relay server. The IFrame stays visible and YouTube remains the singer-side monitor only.

Also, `getCurrentTime()` is a media timeline value. It does not tell Relay the exact instant at which a sample becomes audible through the phone speaker or headphones, so a device/output calibration offset will still be needed later.

## Solo recording

The computer can record the server output without enabling audible Monitor playback:

1. Start **Microphone** on the phone.
2. Press **Record** on the computer.
3. Speak for a short take.
4. Press **Stop** and play back the result in-page.

Recording is taken before the computer's local Monitor gain.

## Legacy click sync test

The 120 BPM click test is still available as a lower-level engineering diagnostic. It keeps an 800 ms server safety buffer and supports live voice offset adjustment across a +/-500 ms window. It is no longer the preferred first test.

## What this proves so far

- mobile browser microphone capture
- binary PCM transport over WebSocket
- handling different browser audio sample rates
- bounded live buffering instead of ever-growing latency
- server-side microphone gain and click mixing
- independent solo recording
- visible YouTube IFrame loading on the same page as microphone capture
- YouTube playback and browser microphone capture coexist on the tested iPhone
- direct access to YouTube media time and playback-state telemetry without touching YouTube audio
- server-side free-running media timeline with state re-anchors
- media-clock drift measurement against server monotonic time with jitter reporting
- seek/discontinuity classification across YouTube state transitions

## Next milestone

If the media clock remains stable over real-device testing, add a controlled server-side backing source that follows the YouTube timeline for play, pause, seek, buffering, and playback-rate changes. After that, calibrate the fixed device/output phase offset before introducing Discord output.
