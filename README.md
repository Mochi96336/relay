# Relay

Experimental browser-to-server audio relay for a karaoke-style flow.

## Current architecture

The prototype now has a real browser-audio source path in addition to the phone microphone path:

```text
Singer phone
├─ visible YouTube IFrame -> singer listens normally
├─ YouTube media timeline -> Relay server
└─ microphone PCM ---------> Relay server

Robot Relay source browser
└─ visible YouTube IFrame
   └─ follows the phone's video / play / pause / seek timeline
      └─ PipeWire monitor -> backing:stdin -> rendered audio PCM -> Relay server

Relay server
└─ captured YouTube tab audio + phone microphone
   └─ 48 kHz buffered mix -> Monitor / Solo Record
```

The robot source uses the same visible YouTube player surface; Relay does not download a media file or use a YouTube audio-download endpoint. On the validated Debian robot, Chromium is routed to a PipeWire null sink and its monitor feeds the stdin backing bridge. The Chrome extension remains a desktop development adapter, not a robot runtime dependency.

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

`src/audio-session.ts` owns the live mix - both PCM timelines, the session clock, the alignment the mixer applies and the health counters. It is told what happened (a source appeared, a frame arrived, a calibration succeeded) and decides for itself what that does to the audio, rather than having transport events reach in and reset the mix clock directly.

`src/calibration-session.ts` owns one acoustic measurement: collecting, timing out, holding the answer, and knowing which setup that answer describes. Calibration is a tap on the live audio, not a stage in it - `AudioSession` never asks whether a measurement is running, and a normal take never passes through any of it. The server feeds it the same samples it feeds the mix and applies a result to the session's alignment when one lands.

`src/pcm-frame.ts` and `src/timing-calibration.ts` are pure. `src/youtube-timeline.ts` owns the media clock that keeps the desktop player following the phone, which is a control plane and deliberately separate from the audio clock.

## Tests

`npm test` runs the suite on Node's built-in runner; it takes about ten seconds and needs no network.

- `test/timing-calibration.test.ts` feeds the analyser synthetic percussive audio with a known lag baked in and asserts the lag comes back.
- `test/youtube-timeline.test.ts` drives `YouTubeTimelineTracker` with an injected clock and pins the anchor / re-anchor / seek classification.
- `test/calibration-session.test.ts` drives the measurement lifecycle with an injected clock and a stubbed analyser: progress, completion, timeout, retry after failure, and which setup an answer is bound to.
- `test/audio-session.test.ts` drives `AudioSession` with an injected clock: timeline placement, holes, re-anchoring, the read-ahead alignment, starvation and the prebuffer.
- `test/pcm-frame.test.ts` pins the wire format, including the byte offsets the two browser encoders duplicate by hand.
- `test/server.test.ts` starts the real server as a child process on an OS-assigned port and exercises it over WebSockets: raw microphone passthrough, the live mix, publisher takeover, mix-health starvation and gap reporting, reconnecting onto an existing timeline, shared-key auth, and the full calibration lifecycle.

`src/server.ts` reads `RELAY_LIVE_PREBUFFER_MS`, `RELAY_CALIBRATION_TIMEOUT_MS` and `RELAY_HEARTBEAT_MS` so tests do not have to spend the production timings on every run. They default to the production values.

### Known gap: the analyser still accepts unrelated audio

The analyser's guards (`MIN_GLOBAL_CORRELATION` 0.12, and the 140 ms window-spread limit) are permissive. Given two unrelated recordings it usually still returns a result, reporting confidence around 0.4-0.6 against 1.0 for a true match. Tightening the thresholds needs real device captures to calibrate against, so `test/timing-calibration.test.ts` pins the discrimination margin that any change has to preserve rather than asserting a rejection that does not happen.

This is a property of the analyser, and it is unchanged. What changed is that a single result no longer reaches the mix — see [Why a measurement has to repeat itself](#why-a-measurement-has-to-repeat-itself). Anything relying on `analyzeTimingCalibration` directly still has to deal with this.

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

## Robot YouTube source

On the Debian robot, start Relay and then launch the validated browser audio route:

```bash
PORT=3100 npm run robot:source
```

`PORT` defaults to `3000`. The launcher creates or reuses the `relay_browser` PipeWire/PulseAudio sink, captures its monitor as mono 48 kHz PCM, feeds `backing:stdin`, and starts an isolated Chromium under Xvfb in unattended robot mode.

The source URL must use `localhost`, not `127.0.0.1`; the latter produced `Video unavailable` in the real-device comparison. See `ROBOT_DEPLOYMENT.md` for the deployment contract, prerequisites, cleanup behavior, and the boundary before adding boot services.

## Live mix timing

The live mix keeps a 400 ms server buffer (`RELAY_LIVE_PREBUFFER_MS`). It buys room to align the remote microphone against the locally captured song, and it is paid for in output latency.

The mixer reads the microphone history *ahead* by `appliedMicAdvanceMs`, so what the buffer has to cover is that read-ahead:

```text
margin = prebuffer - appliedMicAdvanceMs
```

Transport delay does not appear. Since both sides carry absolute sample indices, a slow link changes *when* audio lands, not *where* it is placed — the frames it holds up still land at the index they were captured at.

**The prebuffer is a pure output delay**, and it was 4 s until measurements showed what that cost. Monitor playback adds its own 250 ms on top, so the singer heard themselves ~4.25 s late, which no one can sing against. It never affected *alignment* — it delays both streams equally — so the recordings were fine while the monitor was unusable, which is why it took a while to find.

The advance is clamped to what the buffers actually afford (`prebuffer - 200 ms` ahead, retained history behind) rather than obeyed on faith. Obeying an oversized measurement reads past the end of the microphone history and the vocal disappears; clamping leaves it late but audible, and `requestedMicAdvanceMs` diverging from `appliedMicAdvanceMs` in `source-status` is the signal to raise the prebuffer. Measured lags have so far run *negative* — the desktop player sits behind the phone — and those are paid for out of retained history, costing no prebuffer at all.

When the margin does run out the mixer reads past the end of the microphone history and the vocal drops out in chunks; the server counts those frames and reports them as `mix-health`, which `source.html` and Solo recording both display, instead of failing silently.

### Take quality is measured over the take

`mix-health` counters run for the whole live session. Solo recording baselines them when a take starts and quotes the difference, because a phone that was away *before* you pressed record is not damage to the recording — a 49 s take once reported a 48.7 s vocal gap alongside a single starved frame, which is what that bug looks like from the outside.

`clippedSamples` counts what the summing stage had to clamp. Hard clipping sounds like a bad connection rather than like a level problem, so it is worth naming explicitly.

### Microphone gain

A voice peaks some 16 dB above its own average, so one static gain cannot serve both ends of it: loud enough to hear clips on transients, safe enough never to clip is inaudible. The window between them is narrow and it moves every time the singer does — which is what made this unturnable by ear.

Two things close that gap:

- **A peak limiter on the microphone**, between its gain and the sum (`src/audio-session.ts`). Textbook feed-forward design — peak-hold detector, gain smoothed on a one-pole, threshold at −1 dBFS. Its look-ahead is free here: the microphone is read out of a buffer by index, so the detector can run 3 ms in front of the output without delaying anything, and therefore without moving the alignment. Above the threshold more gain now buys more limiting rather than more distortion; 24 dB and 36 dB produce the same output level, which is what stops the knob from being critical. The clamp stays as a backstop, because the limiter only holds down the voice and the voice plus the song can still overflow.
- **A measured recommendation.** `AudioSession` meters the raw microphone continuously — peak and RMS over a couple of seconds — and `source.html` reports it live next to the gain slider along with the gain that would land peaks on the limiter threshold (`-1 - micPeakDbfs`). Setting this by ear meant hunting a band you cannot see.

  The meter deliberately watches the live stream rather than the calibration, even though the calibration also measures the microphone. Calibration asks the singer to stay quiet for its six seconds, so what it measures is the room and the phone's own speaker — not the voice the gain has to carry. Measuring the peak directly also avoids having to assume a crest factor to get there from RMS.

`limitedSamples` reports how much the limiter worked. It is not a fault — but a take limited almost end to end has had its dynamics flattened, and that is worth knowing.

### Framed PCM

Microphone and captured-source frames carry a 16-byte header stating the capture session and the index of their first sample; `src/pcm-frame.ts` documents the layout and `test/pcm-frame.test.ts` pins it, because the browser encoders write it by hand.

This is what lets the two streams be placed on the session timeline instead of appended in arrival order, and it removes three long-standing problems:

- A dropped uplink chunk used to pull every later sample earlier with nothing recording the fact. The gap is now exactly as long as the audio that went missing, and is reported as `micGapMs` / `backingGapMs`.
- A microphone reconnect used to reset the mix epoch, costing every listener another full prebuffer of silence. The capture keeps counting samples through a transport outage, so the reconnected stream rejoins the timeline it already had and only the outage itself is silent.

The captured song now works the same way. Its socket closing used to end the whole live session — clearing both timelines, the alignment and the calibration — even though the extension reconnects after a second and its own code says it expects to rejoin the timeline it left. A desktop blip therefore threw away the phone's audio too. A source that goes missing starts a grace period (`RELAY_BACKING_GRACE_MS`, 10 s) instead; only when it expires is the session really over. A genuinely new capture is a different matter, and is caught by its generation the same way the microphone's is.

### The phone holds the controls

`ROBOT_DEPLOYMENT.md` puts the finished topology at phone + robot, with the desktop standing in for the robot's browser host during development. Nobody is at that screen, so nothing the singer needs may live only on it.

Song level and mic gain are therefore server state, not page state. Both pages carry a slider, either can move it, and the server echoes the change to the other. Song level can still only be *acted* on by the page that owns the mirrored player — it ends up as `player.setVolume` — which is exactly why the value has to travel rather than being read off a local slider.

Calibration runs unattended, but the singer is the one who can hear that it landed wrong, so the phone has its own button for it.

### Calibration runs itself

The desktop is meant to run unattended, so the measurement does not wait for anyone to press the button. Once a session is live with both sides connected and the phone playing, the server takes one on its own, and retries every `RELAY_AUTO_CALIBRATION_RETRY_MS` (15 s) until one lands. Failing is usually the singer being mid-phrase, which stops being true a few seconds later, so `source.html` shows an unattended failure as a wait rather than an error. Set `RELAY_AUTO_CALIBRATE=0` to go back to pressing the button.

It only fires when there is nothing usable to fall back on — no measurement, or one that no longer describes this setup. That keeps it away from a take in progress: applying a fresh alignment mid-song shifts the vocal audibly, and every event that invalidates a measurement has already disturbed the take anyway.

### Connected is not streaming

Reloading `source.html` destroys the tab capture, but the extension's WebSocket lives in an offscreen document and survives it. The server is then holding a registered, open `backing` client with no audio behind it — and every check written against socket state says everything is fine.

That state used to be invisible until a calibration started against it and sat at 0 % for the full timeout, reporting only that progress had stopped. Calibration now refuses to start unless frames have actually arrived from both sides recently, gives up quickly if one goes quiet mid-collection, and names the side in both cases. `source-status` carries `micStreaming` / `backingStreaming` so `source.html` can say it without anyone pressing anything.

### Why a measurement has to repeat itself

The analyser accepts unrelated audio at a confidence of 0.4–0.6 against 1.0 for a true match, reporting plausible-looking lags that are simply wrong (`test/timing-calibration.test.ts` pins the margin). While a person pressed the button that was survivable: an implausible number got re-run. Automating the trigger removed the reviewer and the flaw started reaching the mix, heard as the song arriving twice, badly offset, intermittently.

Confidence cannot separate the two cases — that is what the pinned margin says. Repeatability can: a false positive lands on a different lag every window, a real match does not move. So a measurement is applied only once `RELAY_CALIBRATION_AGREEMENT` (3) separately collected windows land within `RELAY_CALIBRATION_TOLERANCE_MS` (25 ms) of each other, and a window that disagrees costs the run the progress it invalidates rather than being averaged in. The first window is never applied on its own.

Measured over consecutive windows of unrelated audio, the analyser accepts most of them and invents a lag that jumps hundreds of milliseconds each time; three in a row never landed within tolerance across the seeds tested. `test/calibration-session.test.ts` pins both halves of that — unrelated streams producing nothing, a real match still landing.

The cost is time, not CPU — one analysis is about 4 ms against a 20 ms frame budget, so the limit is the 6 s each window takes to collect. Set `RELAY_CALIBRATION_AGREEMENT=1` for the old single-shot behaviour.

`RELAY_CALIBRATION_MAX_LAG_MS` (700) bounds how far the analyser looks. This is **not** what rejects false positives — narrowing the search from ±2 s changed where they land but not how often they are accepted. It is about applicability: the mixer clamps the advance to what its buffers afford, so a measurement of −1975 ms would be applied as −1300 ms and still report success. The bound is physical — the desktop player is only corrected past 450 ms of error, transport adds a fraction of that locally, and the acoustic path is a few milliseconds — so nothing real lives outside it, while beat multiples do.

### Test mode is only the test

`test-status` describes the click sync test and nothing else. It used to report a running live session as `mode: 'tab-source'`, because the browser clients had no other way to learn that the server had started mixing — so every live take ran them in test mode. That dropped the monitor slider to 0 dB at the start of each take and stopped remembering what the singer set during it. A live session is described by `source-status`; the clients listen to that, and derive "the server is mixing" from either source.
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
