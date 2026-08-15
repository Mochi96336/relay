# Handoff

State of the work as of `1cb8e91`, written for picking this up on another machine. `README.md` describes how the system works; this file is what a fresh session would otherwise have to rediscover. Updated after a real integrated session on the robot itself (2026-08-15 evening) — see "What tonight's robot session found" below for what that changed.

## What is verified and what is not

The audio core is covered by 120 tests (`npm test`, ~15 s, no network) and `npm run check` is clean. That is not the same as working.

Confirmed on real hardware:

- Monitor level is correct again after the test-mode fix.
- A 400 ms prebuffer holds: a 70 s take reported one starved frame.
- Take-scoped health counters report the take rather than the session.
- **The full robot route runs end to end on real hardware** (phone mic over a Cloudflare tunnel, robot Chromium mirroring YouTube through PipeWire, `backing:stdin`, `RELAY_CALIBRATION_AGREEMENT=3`): mic and backing both stream, calibration collects, and — after the fix below — converges on a plausible small lag rather than a beat-period alias.

**Never validated on real hardware, individually or together:**

- the microphone limiter,
- a desktop capture blip not ending the take,
- the phone-side controls and song-level routing,
- clipping detection (never observed firing),
- an actual sung take with the mix confirmed audibly in sync (tonight got calibration converging; nobody sang into it).

An integrated take with someone actually singing is still the next step, specifically so that a failure on the robot can be attributed to the deployment rather than to the audio core.

## What tonight's robot session found

Three real problems, in the order they were found and fixed or ruled out. All three produce the same symptom from a phone speaker distance — audio that sounds obviously wrong to a person, unattended calibration that produces a suspiciously large lag — so do not assume one explains the other without checking `timing-calibration-status` directly.

1. **A page reload does not re-anchor the microphone. It should have and did not.** `captureGeneration` in `public/app.js` is a plain `let` starting at 0, bumped once per capture start. Reloading the phone page resets it to the same value the *first ever* connection used, so `timeline.generation !== frame.generation` in `audio-session.ts` sees no change and skips re-anchoring. The mic timeline then keeps extending from whatever `originOffset` the very first connection computed, drifting further from correct the longer the server process has been running — we watched it go from a wrong -7195 ms to a worse -18595 ms across one reload. **The fix is restarting the Relay server process, not reloading the phone page.** A real fix would make `captureGeneration` globally unique (e.g. seed it from `Date.now()` or a random value instead of 0), which nobody has done yet.
2. **The analyser locks onto beat-period aliases, live, not just in theory.** Thread 2 below documented this as a known gap; tonight it was watched happening in real time against a real recorded chorus — repeated automatic attempts landing on ±550-700 ms with confidence 0.4-0.6, while the true answer (confirmed once by a high-confidence 0.797 read) was ~150-250 ms. `RELAY_CALIBRATION_AGREEMENT=3` correctly rejected every one of those, exactly as designed, but never got three that agreed either, because a repeated beat produces a *different* alias each attempt while the true small lag is comparatively rare against it — a real, not just theoretical, availability problem for a live take. **Fixed**: `bestLagAcrossOverlap` in `src/timing-calibration.ts` now also searches within `PREFERRED_LAG_MS` (300 ms) and prefers that candidate whenever it scores within `PREFERRED_LAG_CORRELATION_MARGIN` (0.08) of the global best, on the same physical-plausibility reasoning `RELAY_CALIBRATION_MAX_LAG_MS` already used (nothing real lives far from zero; a comparably-strong distant candidate is that same beat, aliased). Regression tests in `test/timing-calibration.test.ts` (`prefers a ... lag over its ... ms beat-period alias`) use a new `beatTrain`/`laggedBeatPair` harness with a *regular* beat, which `pulseTrain`'s irregular spacing had never exercised — that gap in the test data is why this shipped undetected. This plausibly explains open thread 1 below (the song heard twice, unattended) better than the false-positive theory that motivated agreement in the first place: a beat-alias lag large enough to read past the end of mic history would produce exactly that symptom.
3. **Cloudflare tunnel checked and ruled out.** The phone connects through `cloudflared tunnel --url http://localhost:$PORT`. Its `clock-ping`/`youtube-telemetry` RTT (`networkRttMs`, `transportEstimateMs`) stayed at 20-30 ms throughout, so the tunnel is not adding meaningful or variable latency. Do not re-investigate this without new evidence.

## Things that cost time to rediscover

- **Source changes need the server restarted.** `npm start` does not watch. Several confusing sessions came from reading new UI against an old server — including one where a calibration reported a lag the current search range cannot produce.
- **The source URL must use `localhost`, not `127.0.0.1`.** The latter gives `Video unavailable`. Found on the real device.
- **Reloading `source.html` destroys the tab capture** while the extension's WebSocket, which lives in an offscreen document, stays open and registered. The server sees a healthy `backing` client with no audio behind it. It now says so; before, a calibration would sit at 0 % for the whole timeout. On the robot there is no extension, and the equivalent failure is the PipeWire route or `backing:stdin`.
- **`tabCapture` needs a user gesture on every Chromium start.** That is a browser security boundary, not a bug to route around, which is why the robot path replaces the extension rather than automating it.
- **Both singer-facing controls exist on two pages.** Mic gain and song level are server state; either page can move them and the server echoes to the other. Song level can only be *acted* on by the page owning the mirrored player.
- **Reloading the phone page does not fix a wedged microphone timeline; restarting the server does.** See "What tonight's robot session found" above. Register as a `monitor` role over a plain WebSocket (`{type:'register', role:'monitor'}`) to watch `mix-health.micHeadroomMs` — frozen at a large negative number while `micStreaming` stays true is this bug, not a network problem.
- **`npm run robot:source` already owns the whole browser-audio pipeline.** Running `parec`, `backing:stdin`, and `xvfb-run chromium` by hand in separate terminals works but leaves orphaned `Xvfb` displays and a second, conflicting `backing:stdin` behind on every restart. Use the one launcher command; it cleans up its own children on `SIGTERM`.

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
| `RELAY_CALIBRATION_AGREEMENT` | `3` | Windows that must agree before a measurement is *confirmed* |
| `RELAY_CALIBRATION_PROVISIONAL_CONFIDENCE` | `0.55` | Confidence a single window applies at immediately, ahead of agreement (see below) |
| `RELAY_CALIBRATION_TOLERANCE_MS` | `25` | How close those windows must land |
| `RELAY_CALIBRATION_MAX_LAG_MS` | `2500` | How far the analyser may look |
| `RELAY_CALIBRATION_TIMEOUT_MS` | `20000` | Backstop when a side stops streaming |
| `RELAY_MIC_RETENTION_MS` | `3000` | Microphone history kept, so the ceiling on reading *behind* |
| `RELAY_CALIBRATION_PROBE` | on (`0` disables) | Boot calibration by probe instead of song content |
| `RELAY_CALIBRATION_PROBE_RETRY_MS` | `6000` | Gap between probe attempts |
| `RELAY_CALIBRATION_PROBE_SEARCH_MARGIN_MS` | `3000` | Largest path delay a probe can find |
| `RELAY_CALIBRATION_PROBE_MIN_CORRELATION` | `0.5` | Below this a probe is treated as not heard |
| `RELAY_CALIBRATION_DELTA_REAPPLY_MS` | `40` | How far `delta` must move before the vocal follows it |
| `RELAY_CALIBRATION_PROBE_DEBUG` | off (`1` enables) | Logs each leg's correlation and latency |
| `RELAY_HEARTBEAT_MS` | `8000` | Dead-socket detection |

Robot route (`scripts/robot-source.sh` and `src/backing-stdin.ts`): `RELAY_BROWSER_SINK` (`relay_browser`), `CHROMIUM_BIN` (autodetected), `RELAY_URL` (`ws://127.0.0.1:$PORT/ws`), `RELAY_BACKING_SAMPLE_RATE` (`48000`), `RELAY_BACKING_FRAME_MS` (`20`).

**`RELAY_CALIBRATION_AGREEMENT * durationMs` (6 s/window) is a hard floor on how long calibration takes, even in the best case** - 18 s at the default of 3. A singer hearing nothing corrected for that whole stretch has its own cost, raised live tonight. `RELAY_CALIBRATION_PROVISIONAL_CONFIDENCE` applies the *first* window that clears it immediately - agreement keeps running in the background regardless and still replaces it the moment it lands, same mechanism `CalibrationSession` already used to protect a confirmed answer from a later disagreeing window. Real confidence tonight: ~0.6-0.8+ for a match, ~0.45-0.6 for a rejected, not-yet-agreeing window - 0.55 is a working line between them, not a validated one. Set it above 1 to disable and restore the old silent-until-confirmed behaviour. `timing-calibration-status.provisional` (and the `· 已套用暫定值 ... ms` text on both pages) says which kind of answer is currently applied.

## Boot calibration, and the two-second offset it explained

A recording came back with the vocal a whole two seconds off the backing, over the entire take. That is far outside anything the old setup could even measure, let alone apply, and chasing it turned up three separate things.

**The measurement was right and was being thrown away.** An earlier run had reported -1790 ms at confidence 0.98 with five windows inside 15 ms - the signature of a true match, not the 0.4-0.6 an alias scores. It was dismissed as a beat alias on the reasoning recorded in `e5e38f0`: the follower corrects past 450 ms, so nothing real lives past 700 ms. That reasoning only accounted for the *players*. It missed that the phone's uplink and the robot's browser-to-PipeWire capture each add their own delay, neither of which the follower's dead band bounds. Searching only to 700 ms did not rule the real answer out as implausible, it made it unmeasurable.

**And it was silently truncated even when measured.** `retentionMs` was `MAX_OFFSET_MS + 1000`, so `appliedMicAdvanceMs` clamped at 1300 ms after the safety margin while `requestedMicAdvanceMs` said -1790: a ~500 ms error, reported as a successful calibration. Reading *behind* spends retained history, not prebuffer, so `RELAY_MIC_RETENTION_MS` buys correction range for memory alone (~96 KB/s) and costs no output latency. Any gap between those two numbers means this is happening again.

**Boot calibration measures the whole thing as three terms instead of one.** See `src/boot-calibration.ts` for the derivation of

    advance = micLatency - backingLatency + delta

Two probes - three clicks at irregular offsets, so no shift but the true one lines all three up - are played once down each path: the phone plays one its own microphone hears, and the robot's page plays one into the same null sink the song goes to, so it arrives through PipeWire exactly as the song does. `delta`, the robot player's position minus the phone's, needs no probe: the follower already computed it to decide whether to seek and used to discard it.

Measured on the robot, and this is the answer to the two seconds:

| Leg | Measured | Correlation |
| --- | --- | --- |
| `micLatency` | 50 ms | 0.73 |
| `backingLatency` | **2110 ms** | 0.84 |
| `delta` | +250 ms | reported |
| applied advance | -1810 ms | requested == applied |

Content correlation had independently measured -1790 ms when `delta` was near zero, which is the same answer by a completely different method.

Two consequences worth keeping:

- **The probes run once; `delta` tracks live.** The two path delays are properties of the capture pipeline and only a restarted capture invalidates them. `delta` is the only term a seek moves, and it is read continuously, so a seek no longer costs a re-measurement - which is also why the probe clicks stopped firing repeatedly during playback.
- **`backingLatency` of 2110 ms is itself the thing to attack next.** That is `parec`/PipeWire buffering, not something inherent. Cutting it shrinks the correction, the retention it needs, and the room for any of this to go wrong. The system now compensates for it correctly, which is not the same as it being reasonable.

`timing-calibration-status.bootCalibration` reports all three terms, so a wrong total can be attributed to the path that produced it instead of re-measured blind. A single probe cannot replace this: the phone's speaker and the robot's audio never meet in the air, so no one probe crosses both paths - which is exactly what the first attempt at this got wrong, measuring `micLatency` alone and applying it as the total.

## Two measurements worth not repeating

Both were taken on a development desktop; scale them for the target.

- **The mixer is free.** 0.034 ms per 20 ms frame — 0.17 % of one core, roughly 580× headroom. A slower machine is not a problem for the mix path.
- **One calibration analysis is about 4 ms.** On a much slower machine this can exceed a frame budget, but `drain` catches up at five frames per 5 ms tick and the monitor's 250 ms jitter buffer absorbs it. It is not a reason to move the analysis off-thread.

## Open threads

1. **The last symptom is now plausibly explained, not confirmed.** The song was heard twice, far apart, intermittently. The diagnosis was a false positive being applied unattended, and agreement was built to stop it — but a beat-period alias landing outside the mixer's usable buffer range would produce exactly this symptom (the mixer's read head lands past the end of mic history), and tonight's session watched that failure mode happen live. Worth a real take to close out, but no longer the top-priority unknown.
2. **The analyser accepted unrelated audio at 0.4–0.6 confidence; this is meaningfully better, not solved.** `bestLagAcrossOverlap` now prefers a nearby (`PREFERRED_LAG_MS`, 300 ms) candidate over a distant one unless the distant one clearly wins — see "What tonight's robot session found" above. This closes the specific failure that blocked a real take tonight (repeated beat-multiple lock-on), verified against a regression test built from a genuinely periodic signal. It does **not** fix the analyser's fundamental permissiveness: two unrelated recordings can still score 0.4–0.6, and agreement is still what keeps a single bad read out of the mix. Anything calling `analyzeTimingCalibration` directly still inherits that.
3. **Built: a known probe signal instead of song content.** See "Boot calibration" above. Cross-correlating against the song is inherently ambiguous for anything with a beat, no matter how the thresholds are tuned — a true match and a one-period-away alias can both be genuinely strong correlations, not noise. Two subtleties are worth keeping so they do not have to be re-derived. First, the timing reference: comparing "where the mic's own anchor (`originOffset`) places the probe" against "where correlation finds it in that same anchored timeline" measures nothing, because both come from one deterministic formula applied to one `firstSampleIndex`. The anchor's bias can only be measured against a clock that does *not* pass through it, which is why the probe's expected position comes from the server's own send/receive round trip mapped onto `sessionSampleAt`. Second, and the thing the first attempt got wrong: one probe is not enough. The phone's speaker and the robot's audio never meet in the air, so a phone-speaker-to-phone-mic probe measures `micLatency` alone; applying that as the whole answer is confidently wrong. It needs a leg down each path plus the robot's own player offset.
4. **The desktop player's ±450 ms dead band** ([`public/source.js`](public/source.js), the `seekTo` guard) is deliberate — correcting more often would mean more audible re-buffers, each also invalidating the calibration. A seek now marks the measurement stale instead. Measured lags have landed at −60, −205 and −225 ms across runs, all inside that band, which is why they differ.
5. **The click sync test still shares plumbing with the production path.** It is the reason `test-status` and the production session were once conflated. It causes no live fault now; removing it is cleanup, not a fix. (It is also the closest existing thing to thread 3's probe playback — see there before removing it.)
6. **Discord output has not been started.** It is the original goal in `README.md`.
7. **`test/server.test.ts`'s "holds the answer back until independent windows agree" is flaky under load**, unrelated to anything above (reproduces identically without tonight's fix). It spawns a real server subprocess and waits up to 15 s; on a Pi running the live robot route alongside the test suite, that budget is marginal. Not worth chasing unless it starts failing on a quiet machine too.

## Suggested order

Get someone singing into a real take next — calibration now converges in the section of the song that was tested tonight (mid-song, clear vocal and rhythm), so a real take is finally likely to produce a usable answer instead of stalling. That validates thread 1 and the robot route together. Thread 3 (the probe signal) is the next real quality improvement after that, not before it.
