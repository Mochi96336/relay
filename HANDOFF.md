# Handoff

State of the work as of `1cb8e91`, written for picking this up on another machine. `README.md` describes how the system works; this file is what a fresh session would otherwise have to rediscover.

## What is verified and what is not

The audio core is covered by 117 tests (`npm test`, ~15 s, no network) and `npm run check` is clean. That is not the same as working.

Confirmed on real hardware:

- Monitor level is correct again after the test-mode fix.
- A 400 ms prebuffer holds: a 70 s take reported one starved frame.
- Take-scoped health counters report the take rather than the session.

**Never validated on real hardware, individually or together:**

- the microphone limiter,
- three-window calibration agreement,
- a desktop capture blip not ending the take,
- the phone-side controls and song-level routing,
- clipping detection (never observed firing),
- the whole robot route in `scripts/robot-source.sh` — no PipeWire or Debian here, so its test coverage is zero and it rests entirely on the other agent's device validation.

An integrated take on a development desktop was the intended next step, specifically so that a failure on the robot can be attributed to the deployment rather than to the audio core. It has not happened.

## Things that cost time to rediscover

- **Source changes need the server restarted.** `npm start` does not watch. Several confusing sessions came from reading new UI against an old server — including one where a calibration reported a lag the current search range cannot produce.
- **The source URL must use `localhost`, not `127.0.0.1`.** The latter gives `Video unavailable`. Found on the real device.
- **Reloading `source.html` destroys the tab capture** while the extension's WebSocket, which lives in an offscreen document, stays open and registered. The server sees a healthy `backing` client with no audio behind it. It now says so; before, a calibration would sit at 0 % for the whole timeout. On the robot there is no extension, and the equivalent failure is the PipeWire route or `backing:stdin`.
- **`tabCapture` needs a user gesture on every Chromium start.** That is a browser security boundary, not a bug to route around, which is why the robot path replaces the extension rather than automating it.
- **Both singer-facing controls exist on two pages.** Mic gain and song level are server state; either page can move them and the server echoes to the other. Song level can only be *acted* on by the page owning the mirrored player.

## Where the tuning lives

Everything below is read once at startup.

| Variable | Default | What it decides |
| --- | --- | --- |
| `PORT` | `3000` | HTTP + WebSocket port |
| `RELAY_KEY` | unset | Shared key; must match the `?key=` on every page |
| `RELAY_LIVE_PREBUFFER_MS` | `400` | Pure output delay, and the read-ahead the mixer can afford |
| `RELAY_BACKING_GRACE_MS` | `10000` | How long a missing song source may be away before the session ends |
| `RELAY_AUTO_CALIBRATE` | on (`0` disables) | Whether calibration triggers itself |
| `RELAY_AUTO_CALIBRATION_RETRY_MS` | `15000` | Gap between unattended attempts |
| `RELAY_CALIBRATION_AGREEMENT` | `3` | Windows that must agree before a measurement is applied |
| `RELAY_CALIBRATION_TOLERANCE_MS` | `25` | How close those windows must land |
| `RELAY_CALIBRATION_MAX_LAG_MS` | `700` | How far the analyser may look |
| `RELAY_CALIBRATION_TIMEOUT_MS` | `20000` | Backstop when a side stops streaming |
| `RELAY_HEARTBEAT_MS` | `8000` | Dead-socket detection |

Robot route (`scripts/robot-source.sh` and `src/backing-stdin.ts`): `RELAY_BROWSER_SINK` (`relay_browser`), `CHROMIUM_BIN` (autodetected), `RELAY_URL` (`ws://127.0.0.1:$PORT/ws`), `RELAY_BACKING_SAMPLE_RATE` (`48000`), `RELAY_BACKING_FRAME_MS` (`20`).

## Two measurements worth not repeating

Both were taken on a development desktop; scale them for the target.

- **The mixer is free.** 0.034 ms per 20 ms frame — 0.17 % of one core, roughly 580× headroom. A slower machine is not a problem for the mix path.
- **One calibration analysis is about 4 ms.** On a much slower machine this can exceed a frame budget, but `drain` catches up at five frames per 5 ms tick and the monitor's 250 ms jitter buffer absorbs it. It is not a reason to move the analysis off-thread.

## Open threads

1. **The last symptom is unconfirmed.** The song was heard twice, far apart, intermittently. The diagnosis was a false positive being applied unattended, and agreement was built to stop it — but that was never re-tested. This is the first thing to check.
2. **The analyser itself still accepts unrelated audio** at 0.4–0.6 confidence. Agreement keeps it out of the mix; nothing fixed the analyser. Tightening its thresholds needs real device captures, which have never been collected. Anything calling `analyzeTimingCalibration` directly inherits the flaw.
3. **The desktop player's ±450 ms dead band** ([`public/source.js`](public/source.js), the `seekTo` guard) is deliberate — correcting more often would mean more audible re-buffers, each also invalidating the calibration. A seek now marks the measurement stale instead. Measured lags have landed at −60, −205 and −225 ms across runs, all inside that band, which is why they differ.
4. **The click sync test still shares plumbing with the production path.** It is the reason `test-status` and the production session were once conflated. It causes no live fault now; removing it is cleanup, not a fix.
5. **Discord output has not been started.** It is the original goal in `README.md`.

## Suggested order

Do the integrated take before anything else, on whichever machine is quickest to get a singer in front of. It validates six changes at once and answers thread 1. Then move deployment, so that any new failure is attributable.
