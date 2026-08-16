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
   └─ 48 kHz buffered authoritative mix
      ├─ Monitor
      └─ TakeSession -> streaming PCM16 WAV -> takes/<takeId>.wav
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

Use the same `?key=some-random-string` query on the phone and on `source.html`. The same key also protects completed Take WAV artifacts.

## Server structure

`src/server.ts` is the transport layer: websocket routing, roles, status broadcasts and the diagnostics. It no longer owns the audio or the Take file lifecycle.

`src/audio-session.ts` owns the live mix - both PCM timelines, the session clock, the alignment the mixer applies and the health counters. It is told what happened (a source appeared, a frame arrived, a calibration succeeded) and decides for itself what that does to the audio, rather than having transport events reach in and reset the mix clock directly.

`src/take-session.ts` owns the room recording lifecycle: `idle -> recording -> finalizing -> ready`, with `failed` as a terminal failure state. A Take records who pressed Start and Stop, but it does not belong to the Mic owner; a Mic handoff does not split the recording.

`src/take-controller.ts` binds that lifecycle to one server-side WAV writer. `src/wav-take-writer.ts` streams the exact authoritative mixed PCM to a hidden `.wav.part`, patches and fsyncs the RIFF header at finalization, then publishes the stable `.wav`. Disk writes never block the mixer; a bounded write queue turns a persistently unhealthy filesystem into an explicit failed Take instead of unbounded process memory.

`src/calibration-session.ts` owns one acoustic measurement: collecting, timing out, holding the answer, and knowing which setup that answer describes. Calibration is a tap on the live audio, not a stage in it - `AudioSession` never asks whether a measurement is running, and a normal take never passes through any of it. The server feeds it the same samples it feeds the mix and applies a result to the session's alignment when one lands.

`src/pcm-frame.ts` and `src/timing-calibration.ts` are pure. `src/youtube-timeline.ts` owns the media clock that keeps the desktop player following the phone, which is a control plane and deliberately separate from the audio clock.

## Tests

`npm test` runs the suite on Node's built-in runner and needs no network.

- `test/timing-calibration.test.ts` feeds the analyser synthetic percussive audio with a known lag baked in and asserts the lag comes back.
- `test/youtube-timeline.test.ts` drives `YouTubeTimelineTracker` with an injected clock and pins the anchor / re-anchor / seek classification.
- `test/calibration-session.test.ts` drives the measurement lifecycle with an injected clock and a stubbed analyser: progress, completion, timeout, retry after failure, and which setup an answer is bound to.
- `test/audio-session.test.ts` drives `AudioSession` with an injected clock: timeline placement, holes, re-anchoring, the read-ahead alignment, starvation and the prebuffer.
- `test/pcm-frame.test.ts` pins the wire format, including the byte offsets the two browser encoders duplicate by hand.
- `test/take-session.test.ts` pins the room-owned Take lifecycle, stale Stop protection, cross-participant Stop and terminal failure.
- `test/wav-take-writer.test.ts` pins PCM16 WAV layout, atomic `.part -> .wav` publication, cleanup and bounded disk backpressure.
- `test/take-server.test.ts` starts the real server and proves authoritative mixed PCM becomes a downloadable WAV, survives controller disconnect and Mic takeover, auto-finalizes when the live mix truly ends, and keeps shared-key protection.
- the remaining real-server suites exercise raw microphone passthrough, the live mix, publisher takeover, mix-health starvation and gap reporting, reconnecting onto existing timelines, shared-key auth, playback authority and calibration lifecycle.

`src/server.ts` reads `RELAY_LIVE_PREBUFFER_MS`, `RELAY_CALIBRATION_TIMEOUT_MS` and `RELAY_HEARTBEAT_MS` so tests do not have to spend the production timings on every run. They default to the production values.

### Known gap: the analyser still accepts unrelated audio

The analyser's guards (`MIN_GLOBAL_CORRELATION` 0.12, and the 140 ms window-spread limit) are permissive. Given two unrelated recordings it usually still returns a result, reporting confidence around 0.4-0.6 against 1.0 for a true match. Tightening the thresholds needs real device captures to calibrate against, so `test/timing-calibration.test.ts` pins the discrimination margin that any change has to preserve rather than asserting a rejection that does not happen.

This is a property of the analyser, and it is unchanged. What changed is that a single result no longer reaches the mix — see [Why a measurement has to repeat itself](#why-a-measurement-has-to-repeat-itself). Anything relying on `analyzeTimingCalibration` directly still has to deal with this.

## Desktop YouTube source

Load the unpacked Chrome extension from `chrome-tab-audio-probe/` once in `chrome://extensions`.

For an integrated run:

1. On the computer, open **Monitor** if you want to hear Relay output during development. Recording no longer requires this page or a desktop recorder.
2. On the phone, load YouTube in Relay, start playback, and start **Microphone** if you want voice in the mix.
3. On the computer, open `http://localhost:3000/source.html` (with the same `?key=` when used).
4. The source page automatically mirrors the phone's YouTube video ID and media timeline.
5. Press **Enable source audio** once on the source page. This is the browser user gesture that allows the mirrored player to make sound.
6. While `source.html` is the active tab, click the **Relay Tab Audio Source** extension icon.
7. The extension captures that tab's rendered audio, converts it to mono Int16 PCM, and registers it with Relay as the `backing` source.
8. Relay starts the 48 kHz live mix. Monitor receives it if connected, while any active Take receives the same authoritative mixed PCM directly inside the server.

The source follower uses the existing server media clock. Large source/phone differences are corrected with `seekTo`; play, pause, buffering and deliberate seeks follow the phone timeline.

## Robot YouTube source

On the Debian robot, start Relay and then launch the validated browser audio route:

```bash
PORT=3100 npm run robot:source
```

`PORT` defaults to `3000`. The launcher creates or reuses the `relay_browser` PipeWire/PulseAudio sink, captures its monitor as mono 48 kHz PCM, feeds `backing:stdin`, and starts an isolated Chromium under Xvfb in unattended robot mode.

The source URL must use `localhost`, not `127.0.0.1`; the latter produced `Video unavailable` in the real-device comparison. See `ROBOT_DEPLOYMENT.md` for the deployment contract, prerequisites, and cleanup behavior.

`deploy/` holds systemd **user** units for the server and the route. They are committed to be reviewed and rehearsed, not enabled: the gate on enabling them is the integrated real-device test, and they need `loginctl enable-linger` to start at boot at all, because PipeWire lives in the user session. `ROBOT_DEPLOYMENT.md` has the procedure.

## Live mix timing

The live mix keeps a 400 ms server buffer (`RELAY_LIVE_PREBUFFER_MS`). It buys room to align the remote microphone against the locally captured song, and it is paid for in output latency.

The mixer reads the microphone history *ahead* by `appliedMicAdvanceMs`, so what the buffer has to cover is that read-ahead:

```text
margin = prebuffer - appliedMicAdvanceMs
```

Transport delay does not appear. Since both sides carry absolute sample indices, a slow link changes *when* audio lands, not *where* it is placed — the frames it holds up still land at the index they were captured at.

**The prebuffer is a pure output delay**, and it was 4 s until measurements showed what that cost. Monitor playback adds its own 250 ms on top, so the singer heard themselves ~4.25 s late, which no one can sing against. It never affected *alignment* — it delays both streams equally — so recordings could still be aligned while the monitor was unusable, which is why it took a while to find.

The advance is clamped to what the buffers actually afford (`prebuffer - 200 ms` ahead, retained history behind) rather than obeyed on faith. Obeying an oversized measurement reads past the end of the microphone history and the vocal disappears; clamping leaves it late but audible, and `requestedMicAdvanceMs` diverging from `appliedMicAdvanceMs` in `source-status` is the signal to raise the prebuffer. Measured lags have so far run *negative* — the desktop player sits behind the phone — and those are paid for out of retained history, costing no prebuffer at all.

When the margin does run out the mixer reads past the end of the microphone history and the vocal drops out in chunks. The server already counts those frames in `mix-health`; Phase 0E will bind the relevant evidence to a specific Take instead of making the recording page infer quality from session-wide counters.

### Take recording is server-owned

A Take is now a Relay domain object rather than a browser `MediaRecorder` job. The browser only sends Start / Stop and observes `take-status`; the WAV writer consumes the exact 48 kHz mono Int16 frames emitted by the authoritative live mixer.

A Take is room-owned, not Mic-owned. Participant A can start it, participant B can take the Mic and later stop it, and the same `takeId` remains active throughout. Disconnecting the page that pressed Start also does not stop recording. A temporary backing disconnect inside the existing source grace period stays inside the same Take; only when the authoritative live mix truly ends does Relay auto-finalize it with `stopReason: mix-ended`.

By default artifacts live under `./takes`; set `RELAY_TAKE_DIR` to choose another directory. While recording, the file is `<takeId>.wav.part`. Relay patches and fsyncs the WAV header before atomically renaming it to `<takeId>.wav`, so a partial recording is never advertised as ready. With `RELAY_KEY` configured, `/takes/:takeId.wav` requires the same key and is served with private/no-store caching.

The disk path is deliberately non-blocking for the mixer. The writer allows bounded buffering for short filesystem stalls, but if the pending queue grows beyond its safety ceiling the Take fails explicitly and the partial artifact is cleaned up rather than letting disk backpressure grow process memory without bound.

**Phase 0D only establishes reliable recording and artifact lifecycle. It does not yet grade the recording.** Existing `mix-health`, clipping, limiter, calibration and reconnect evidence remains engineering state; Phase 0E will attach the relevant evidence to each Take and derive Take-level quality summaries.

### Microphone gain

A voice peaks some 16 dB above its own average, so one static gain cannot serve both ends of it: loud enough to hear clips on transients, safe enough never to clip is inaudible. The window between them is narrow and it moves every time the singer does — which is what made this unturnable by ear.

Two things close that gap:

- **A peak limiter on the microphone**, between its gain and the sum (`src/audio-session.ts`). Textbook feed-forward design — peak-hold detector, gain smoothed on a one-pole, threshold at −1 dBFS. Its look-ahead is free here: the microphone is read out of a buffer by index, so the detector can run 3 ms in front of the output without delaying anything, and therefore without moving the alignment. Above the threshold more gain now buys more limiting rather than more distortion; 24 dB and 36 dB produce the same output level, which is what stops the knob from being critical. The clamp stays as a backstop, because the limiter only holds down the voice and the voice plus the song can still overflow.
- **A measured recommendation.** `AudioSession` meters the raw microphone continuously — peak and RMS over a couple of seconds — and `source.html` reports it live next to the gain slider along with the gain that would land peaks on the limiter threshold (`-1 - micPeakDbfs`). Setting this by ear meant hunting a band you cannot see.

  The meter deliberately watches the live stream rather than the calibration, even though the calibration also measures the microphone. Calibration asks the singer to stay quiet for its six seconds, so what it measures is the room and the phone's own speaker — not the voice the gain has to carry. Measuring the peak directly also avoids having to assume a crest factor to get there from RMS.

`limitedSamples` reports how much the limiter worked. It is not automatically a fault, but Phase 0E can use sustained limiting as Take quality evidence rather than asking the UI to interpret the raw counter itself.

### Framed PCM

Microphone and captured-source frames carry a 16-byte header stating the capture session and the index of their first sample; `src/pcm-frame.ts` documents the layout and `test/pcm-frame.test.ts` pins it, because the browser encoders write it by hand.

This is what lets the two streams be placed on the session timeline instead of appended in arrival order, and it removes three long-standing problems:

- A dropped uplink chunk used to pull every later sample earlier with nothing recording the fact. The gap is now exactly as long as the audio that went missing, and is reported as `micGapMs` / `backingGapMs`.
- A microphone reconnect used to reset the mix epoch, costing every listener another full prebuffer of silence. The capture keeps counting samples through a transport outage, so the reconnected stream rejoins the timeline it already had and only the outage itself is silent.

The captured song now works the same way. Its socket closing used to end the whole live session — clearing both timelines, the alignment and the calibration — even though the extension reconnects after a second and its own code says it expects to rejoin the timeline it left. A desktop blip therefore threw away the phone's audio too. A source that goes missing starts a grace period (`RELAY_BACKING_GRACE_MS`, 10 s) instead; only when it expires is the session really over. A genuinely new capture is a different matter, and is caught by its generation the same way the microphone's is.

### The phone holds the controls

`ROBOT_DEPLOYMENT.md` puts the finished topology at phone + robot, with the desktop standing in for the robot's browser host during development. Nobody is at that screen, so nothing the singer needs may live only on it.

Song level and mic gain are therefore server state, not page state. Both pages carry a slider, either can move it, and the server echoes the change to the other. Song level can still only be *acted* on by the page that owns the mirrored player — it ends up as `player.setVolume` — which is exactly why the value has to travel rather than being read off a local slider.

Calibration runs unattended, but the singer is the one who can hear that it landed wrong, so the phone has its own button for it. Take Start / Stop is also room state now; the phone does not have to become an audio recorder to control it.

### Calibration runs itself

The desktop is meant to run unattended, so the measurement does not wait for anyone to press the button. Once a session is live with both sides connected and the phone playing, the server takes one on its own, and retries every `RELAY_AUTO_CALIBRATION_RETRY_MS` (15 s) until one lands. Failing is usually the singer being mid-phrase, which stops being true a few seconds later, so `source.html` shows an unattended failure as a wait rather than an error. Set `RELAY_AUTO_CALIBRATE=0` to go back to pressing the button.

It only fires when there is nothing usable to fall back on — no measurement, or one that no longer describes this setup. That keeps it away from unnecessary recalibration; applying a fresh alignment mid-song shifts the vocal audibly, and every event that invalidates a measurement has already disturbed the take anyway.

### Connected is not streaming

Reloading `source.html` destroys the tab capture, but the extension's WebSocket lives in an offscreen document and survives it. The server is then holding a registered, open `backing` client with no audio behind it — and every check written against socket state says everything is fine.

That state used to be invisible until a calibration started against it and sat at 0 % for the full timeout, reporting only that progress had stopped. Calibration now refuses to start unless frames have actually arrived from both sides recently, gives up quickly if one goes quiet mid-collection, and names the side in both cases. `source-status` carries `micStreaming` / `backingStreaming` so `source.html` can say it without anyone pressing anything.

### Status another machine can poll

`GET /healthz` is liveness only: it returns `{ "ok": true }` for as long as the Relay process exists, which includes every robot failure worth knowing about — the browser died, the sink vanished, the backing bridge stopped. Nothing else was readable from outside, because `mix-health` and `source-status` are pushed over WebSocket to clients that are already connected.

`GET /statusz` reports the route instead, and decides rather than dumps:

```json
{
  "ok": false,
  "state": "fault",
  "faults": ["backing source is connected but no longer sending audio"],
  "warnings": [],
  "uptimeMs": 812345,
  "source": { "backingConnected": true, "backingStreaming": false, "backingFrameAgeMs": 9421, "micConnected": false, "...": "..." },
  "robot": { "route": true, "sourceConnected": false, "deltaFresh": false, "...": "..." },
  "mix": { "micStarvedFrames": 0, "backingGapMs": 0, "...": "..." }
}
```

The split that makes it pollable is between **faults**, which clear `ok` and mean something is definitely broken, and **warnings**, which do not. "Connected but no longer streaming" is a fault; a stale calibration is a warning, because audio still flows on the network estimate. Nobody being connected is neither — that is `state: "idle"` with `ok: true`, since a robot with no singer on it is not a robot that failed.

It is unauthenticated like `/healthz`, so it carries counts and states but never nicknames or keys.

### Why a measurement has to repeat itself

The analyser accepts unrelated audio at a confidence of 0.4–0.6 against 1.0 for a true match, reporting plausible-looking lags that are simply wrong (`test/timing-calibration.test.ts` pins the margin). While a person pressed the button that was survivable: an implausible number got re-run. Automating the trigger removed the reviewer and the flaw started reaching the mix, heard as the song arriving twice, badly offset, intermittently.

Confidence cannot separate the two cases — that is what the pinned margin says. Repeatability can: a false positive lands on a different lag every window, a real match does not move. So a measurement is applied only once `RELAY_CALIBRATION_AGREEMENT` (3) separately collected windows land within `RELAY_CALIBRATION_TOLERANCE_MS` (25 ms) of each other, and a window that disagrees costs the run the progress it invalidates rather than being averaged in. The first window is never applied on its own.

Measured over consecutive windows of unrelated audio, the analyser accepts most of them and invents a lag that jumps hundreds of milliseconds each time; three in a row never landed within tolerance across the seeds tested. `test/calibration-session.test.ts` pins both halves of that — unrelated streams producing nothing, a real match still landing.

The cost is time, not CPU — one analysis is about 4 ms against a 20 ms frame budget, so the limit is the 6 s each window takes to collect. Set `RELAY_CALIBRATION_AGREEMENT=1` for the old single-shot behaviour.

`RELAY_CALIBRATION_MAX_LAG_MS` defaults to 2500 ms and bounds how far the analyser looks. This is **not** what rejects false positives; it limits the search domain, while repeatability across independent windows is what keeps unstable false matches from reaching the live alignment.

### Live-session continuity

The captured song used to be buffered only while a phone was connected, and the mixer stopped entirely without one. Both streams are now independent: an absent phone costs the mix its vocal, not the whole take.

A timing calibration therefore survives a websocket reconnect. It is marked stale only when the microphone starts a *new* capture session, which the server learns from the generation on the first frame that arrives.

Relay uses the phone timeline RTT/2 as a first-order microphone network compensation when the captured tab source connects. `Vocal fine tune` on `source.html` is the manual adjustment on top of the calibrated value; the old `Voice offset` slider is gone, because the live mixer never read it.

A calibration is bound to the live session it was measured in. Disconnecting the capture clears it outright.

This does **not** yet prove final acoustic alignment. `getCurrentTime()` is a media timeline value, not the exact moment a sample becomes audible from the phone output, so a later fixed device/output calibration is still needed.

## YouTube media clock

The phone-side visible YouTube IFrame reports video ID, player state, current media time, duration, playback rate and buffering. Relay forwards that telemetry over a separate WebSocket and maintains a free-running server media timeline.

Normal video/state/rate transitions are counted as re-anchors. Seek/discontinuity jumps are counted separately as corrections. Drift is measured from YouTube media-time progression against the server monotonic receive clock; RTT is used only for approximate transport/phase information.

## Take recording

`start-take` creates one room-owned Take against the currently active authoritative mix and current room song. `stop-take` includes the current `takeId`, which prevents a delayed Stop from an old page from terminating a newer recording. Any identified room participant may control the Take; starter/stopped-by identities are retained as metadata rather than authority ownership.

The controller browser can disconnect and reconnect without affecting the WAV writer. On reconnect it asks for `take-status` and resumes observing the server lifecycle. Mic ownership can also change while recording without splitting the artifact.

The current Phase 0D state keeps the latest Take lifecycle and its artifact metadata in memory and writes the WAV to disk. A persistent Take catalog/history across server restarts is not part of this phase.

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
- the authoritative mixed PCM can be written directly by Relay as a finalized PCM16 WAV without a browser recorder
- a Take survives controller disconnect and Mic handoff without splitting
- a truly ended live mix finalizes the active Take instead of leaving fake recording state

## Next milestone

Phase 0E: bind quality evidence to each Take. Relay already knows about stream gaps, clipping/limiting, calibration validity and reconnects; the next step is to record the evidence that happened during one Take and summarize it without making the UI interpret session-wide engineering counters.
