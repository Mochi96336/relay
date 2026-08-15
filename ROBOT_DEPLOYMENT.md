# Robot deployment contract

Relay's product topology is **phone + robot**. The desktop used during development is only a stand-in for the robot-side browser host.

```text
Singer phone
├─ visible YouTube
├─ YouTube media timeline ───────────────┐
└─ microphone PCM ───────────────────────┤
                                         │
Robot                                    │
├─ Relay server <────────────────────────┘
├─ Xvfb + Chromium
│  └─ http://localhost:$PORT/source.html?robot=1
│     └─ mirrored YouTube
└─ PipeWire backing route
   └─ rendered song PCM ────────────────> Relay server

Relay server
└─ aligned song + microphone
   └─ Monitor / Record / later Discord
```

## Validated browser audio route

The robot route has been validated on Debian 13 arm64:

```text
Chromium
  PULSE_SINK=relay_browser
        ↓
PipeWire/PulseAudio null sink
        ↓
relay_browser.monitor
        ↓
parec --raw --format=s16le --rate=48000 --channels=1
        ↓
npm run backing:stdin
        ↓
Relay
```

This proves both halves of the deployment seam: Chromium's rendered audio reaches raw PCM through PipeWire, and `backing:stdin` frames that PCM and publishes it as Relay's normal `backing` role. The Chrome extension remains useful for desktop development, but it is not part of the robot runtime.

## Localhost is a deployment requirement

The robot source URL **must use `localhost`**:

```text
✓ http://localhost:$PORT/source.html?robot=1
✗ http://127.0.0.1:$PORT/source.html?robot=1
```

On the validated installation, the same YouTube video played through the `localhost` origin and created the expected PipeWire sink input, while the `127.0.0.1` origin showed `Video unavailable`. Treat the hostname as part of the deployment contract, not as an interchangeable loopback spelling.

The port is not part of that contract. Relay defaults to `3000`; use another port when the host already reserves it.

## Launcher

The checked-in launcher owns the complete browser backing route:

```bash
PORT=3100 npm run robot:source
```

It:

- verifies `pactl`, `parec`, `xvfb-run`, `npm`, Node.js, and Chromium are available;
- creates the `relay_browser` null sink only when it does not already exist;
- captures `relay_browser.monitor` as mono 16-bit little-endian PCM at 48 kHz;
- pipes the capture into `backing:stdin`;
- launches an isolated Chromium profile under Xvfb, routed with `PULSE_SINK=relay_browser`;
- always opens `http://localhost:$PORT/source.html?robot=1`; and
- stops its child processes and unloads only a sink module it created itself.

`PORT` defaults to `3000`. `CHROMIUM_BIN` can select a nonstandard Chromium executable, and `RELAY_BROWSER_SINK` can select an existing sink with another name. The backing bridge continues to accept `RELAY_URL`, `RELAY_KEY`, `RELAY_BACKING_SAMPLE_RATE`, and `RELAY_BACKING_FRAME_MS`; see `npm run backing:stdin -- --help`. When `RELAY_KEY` is set, the launcher also adds it to the local source page URL so both browser and backing bridge can authenticate.

Run the Relay server separately before starting the launcher. Robot mode automatically arms source audio, and Chromium is launched with the autoplay policy needed for that unattended local page; no source-page gesture or extension invocation is required.

## Ownership boundaries

- `source.html` mirrors the phone's YouTube media timeline.
- `scripts/robot-source.sh` owns robot-local browser audio capture and process cleanup.
- `src/backing-stdin.ts` owns PCM framing, its capture clock, and backing transport reconnection.
- `src/server.ts` owns WebSocket routing and source lifecycle orchestration.
- `AudioSession` owns the shared PCM timelines, alignment, mixer, and signal processing.
- `CalibrationSession` observes those timelines and owns measurement validity.

The launcher does not create a second mixer clock or alignment model. Observed follower deltas are diagnostics, not configuration: final audio alignment remains the calibration system's job.

## Current checkpoint and next stage

The manually launched robot backing route is reproducible and validated. Full phone microphone + robot backing + automatic calibration still needs an integrated real-device monitor/recording test.

Do not install or commit boot services yet. After that integrated path is validated, the next deployment checkpoint can supervise the Relay server, backing bridge, and browser at boot. That is the point where the deployment can accurately promise unattended startup.
