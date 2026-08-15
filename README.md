# Relay

Experimental browser-to-server audio relay for a karaoke-style flow.

## Current architecture

The prototype now has a real browser-audio source path in addition to the phone microphone path:

```text
Singer phone
├─ visible YouTube IFrame -> singer listens normally
├─ YouTube media timeline -> Relay server
└─ microphone PCM ---------> Relay server

Desktop Relay source tab
└─ visible YouTube IFrame
   └─ follows the phone's video / play / pause / seek timeline
      └─ Chrome tabCapture extension -> rendered tab audio PCM -> Relay server

Relay server
└─ captured YouTube tab audio + phone microphone
   └─ 48 kHz buffered mix -> Monitor / Solo Record
```

The desktop source uses the same visible YouTube player surface; Relay does not download a media file or use a YouTube audio-download endpoint. The Chrome extension captures the final rendered audio of the local `source.html` tab after an explicit extension-button click.

Discord output is not connected yet.

## Run

Requires Node.js 20.19 or newer.

```bash
npm install
npm run check
npm test
npm run dev
```

Open `http://localhost:3000` on the computer.

For the phone, microphone capture requires HTTPS. During development, expose Relay through an HTTPS tunnel and open that URL on the phone.

If the tunnel is public, set a shared key:

```bash
RELAY_KEY=some-random-string npm run dev
```

Use the same `?key=some-random-string` query on the phone and on `source.html`.

## Server structure

`src/server.ts` is the transport layer: websocket routing, roles, status broadcasts and the diagnostics. It no longer owns the audio.

`src/audio-session.ts` owns the live mix - both PCM timelines, the session clock, the alignment the mixer applies and the health counters. It is told what happened (a source appeared, a frame arrived, a calibration succeeded) and decides for itself what that does to the audio, rather than having transport events reach in and reset the mix clock directly. `src/pcm-frame.ts` and `src/timing-calibration.ts` are pure; `src/youtube-timeline.ts` owns the media clock that keeps the desktop player following the phone, which is a control plane and deliberately separate from the audio clock.

## Tests

`npm test` runs the suite on Node's built-in runner; it takes about ten seconds and needs no network.

- `test/timing-calibration.test.ts` feeds the analyser synthetic percussive audio with a known lag baked in and asserts the lag comes back.
- `test/youtube-timeline.test.ts` drives `YouTubeTimelineTracker` with an injected clock and pins the anchor / re-anchor / seek classification.
- `test/audio-session.test.ts` drives `AudioSession` with an injected clock: timeline placement, holes, re-anchoring, the read-ahead alignment, starvation and the prebuffer.
- `test/pcm-frame.test.ts` pins the wire format, including the byte offsets the two browser encoders duplicate by hand.
- `test/server.test.ts` starts the real server as a child process on an OS-assigned port and exercises it over WebSockets: raw microphone passthrough, the live mix, publisher takeover, mix-health starvation and gap reporting, reconnecting onto an existing timeline, shared-key auth, and the full calibration lifecycle.

`src/server.ts` reads `RELAY_LIVE_PREBUFFER_MS`, `RELAY_CALIBRATION_TIMEOUT_MS` and `RELAY_HEARTBEAT_MS` so tests do not have to spend the production timings on every run. They default to the production values.

### Known gap: calibration accepts unrelated audio

The analyser's guards (`MIN_GLOBAL_CORRELATION` 0.12, and the 140 ms window-spread limit) are permissive. Given two unrelated recordings it usually still returns a result, reporting confidence around 0.4-0.6 against 1.0 for a true match. A bogus multi-second lag is not harmless: it puts the mixer's read head past the end of the microphone history immediately, which sounds exactly like the vocal dropping out.

Tightening the thresholds needs real device captures to calibrate against, so for now `test/timing-calibration.test.ts` pins the discrimination margin that any change has to preserve rather than asserting a rejection that does not happen.

## Desktop YouTube source

Load the unpacked Chrome extension from `chrome-tab-audio-probe/` once in `chrome://extensions`.

For an integrated run:

1. On the computer, open **Monitor** or start **Solo recording** on the normal Relay page.
2. On the phone, load YouTube in Relay, start playback, and start **Microphone** if you want voice in the mix.
3. On the computer, open `http://localhost:3000/source.html` (with the same `?key=` when used).
4. The source page automatically mirrors the phone's YouTube video ID and media timeline.
5. Press **Enable source audio** once on the source page. This is the browser user gesture that allows the mirrored player to make sound.
6. While `source.html` is the active tab, click the **Relay Tab Audio Source** extension icon.
7. The extension captures that tab's rendered audio, converts it to mono Int16 PCM, and registers it with Relay as the `backing` source.
8. Relay automatically switches Monitor / Solo Record to the 48 kHz live mix path. Stop the extension capture to return to the normal raw microphone path.

The source follower uses the existing server media clock. Large source/phone differences are corrected with `seekTo`; play, pause, buffering and deliberate seeks follow the phone timeline.

## Live mix timing

The live mix keeps a 4 s server buffer. This is intentional: the singer does not monitor the returned vocal, so end-to-end output latency can be traded for enough room to align the remote microphone with the local captured song.

The buffer has to be this large because the mixer reads the microphone history *ahead* by the calibrated lag. The usable margin is:

```text
margin = prebuffer - 2 * micTransportDelay + backingTransportDelay
```

The microphone delay counts twice, so a 500 ms phone link leaves ~3 s of margin while a 1.5 s link leaves ~1 s. When the margin runs out the mixer reads past the end of the microphone history and the vocal drops out in chunks. The server now counts those frames and reports them as `mix-health`, which `source.html` and Solo recording both display, instead of failing silently.

### Framed PCM

Microphone and captured-source frames carry a 16-byte header stating the capture session and the index of their first sample; `src/pcm-frame.ts` documents the layout and `test/pcm-frame.test.ts` pins it, because the browser encoders write it by hand.

This is what lets the two streams be placed on the session timeline instead of appended in arrival order, and it removes three long-standing problems:

- A dropped uplink chunk used to pull every later sample earlier with nothing recording the fact. The gap is now exactly as long as the audio that went missing, and is reported as `micGapMs` / `backingGapMs`.
- A microphone reconnect used to reset the mix epoch, costing every listener another full prebuffer of silence. The capture keeps counting samples through a transport outage, so the reconnected stream rejoins the timeline it already had and only the outage itself is silent.
- The captured song used to be buffered only while a phone was connected, and the mixer stopped entirely without one. Both streams are now independent: an absent phone costs the mix its vocal, not the whole take.

A timing calibration therefore survives a websocket reconnect. It is marked stale only when the microphone starts a *new* capture session, which the server learns from the generation on the first frame that arrives.

Recording must be done on the computer. Solo recording downloads the full 48 kHz mix and encodes it live, which a phone cannot do while also capturing and uploading the microphone; the page warns if you start it on the publishing device.

Relay uses the phone timeline RTT/2 as a first-order microphone network compensation when the captured tab source connects. `Vocal fine tune` on `source.html` is the manual adjustment on top of the calibrated value; the old `Voice offset` slider is gone, because the live mixer never read it.

A calibration is bound to the live session it was measured in. Disconnecting the capture clears it outright.

This does **not** yet prove final acoustic alignment. `getCurrentTime()` is a media timeline value, not the exact moment a sample becomes audible from the phone output, so a later fixed device/output calibration is still needed.

## YouTube media clock

The phone-side visible YouTube IFrame reports video ID, player state, current media time, duration, playback rate and buffering. Relay forwards that telemetry over a separate WebSocket and maintains a free-running server media timeline.

Normal video/state/rate transitions are counted as re-anchors. Seek/discontinuity jumps are counted separately as corrections. Drift is measured from YouTube media-time progression against the server monotonic receive clock; RTT is used only for approximate transport/phase information.

## Solo recording

Solo recording opens an independent monitor connection and records the Server output before local Monitor gain. With the captured tab source connected, that output is the live song + microphone mix. Without it, recording falls back to the normal microphone relay.

The recorder reconnects on its own if the Relay connection drops mid-take, so a `tsx watch` restart or a tunnel hiccup no longer ends the recording. The dropout becomes silence in the file and is reported in the completion summary along with any buffer underruns and any frames the server had to drop.

## Legacy diagnostics

The 120 BPM click mixer remains as an engineering diagnostic for the microphone uplink and the monitor output path. The synthetic YouTube timecode follower has been removed: the desktop tab capture proves the same timeline end to end with real audio, and the follower's mode flag still altered production microphone routing while it was active.

## What has been proved so far

- iPhone browser microphone capture over HTTPS
- binary PCM transport over WebSocket
- YouTube playback and microphone capture can coexist on the tested phone
- server-side YouTube media timeline with play / pause / seek handling
- seek/discontinuity classification across buffering transitions
- Chrome can capture the rendered audio of a Relay tab containing a YouTube IFrame
- a desktop mirrored YouTube source can be controlled from the phone timeline
- captured desktop tab audio can be forwarded to Relay as PCM
- Relay has a buffered 48 kHz path for combining captured song audio with the phone microphone

## Next milestone

Run one integrated real-device take and inspect the resulting recording. Once the full song + microphone path is stable, calibrate the remaining fixed acoustic/output offset, then add Discord as the final output transport.
