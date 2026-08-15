# Handoff

Current state of draft PR #1 (`agent/web-mic-relay`). `README.md` describes the product surface; this file records the current engineering truth needed to continue work without rediscovering the timing failures already fixed.

## Validation state

GitHub Actions now validates every PR update with:

```bash
npm ci
npm run check
npm test
```

Do not treat CI as a substitute for the next real-hardware test. The audio core and lifecycle contracts are automated; audible sync through the complete phone -> Relay -> robot -> recorder path still needs a fresh sung take after the latest timing-state changes.

Previously confirmed on the Raspberry Pi / robot route:

- phone microphone and robot backing both reach Relay end to end;
- the 400 ms live prebuffer is viable;
- the old ~2 second backing delay was real startup/capture buffering, not CPU load;
- after the buffering fixes, backing/mic headroom returned to roughly the expected 400 ms region;
- Cloudflare RTT was only about 20-30 ms during the observed session and was not the multi-second latency source.

Still worth validating on current head as one integrated take:

- actual sung vocal is audibly aligned for the whole recording;
- mic limiter / clipping diagnostics behave as intended;
- source/player reconnects recover without audible alignment jumps;
- `requestedMicAdvanceMs` and `appliedMicAdvanceMs` remain equal unless a real buffer limit is reached.

## Current robot audio route

Run the route through the launcher, not as three unrelated manual processes:

```text
npm run robot:source
  |
  +-- Chromium source.html?robot=1
  |     -> relay_browser PipeWire/Pulse sink
  |
  +-- parec relay_browser.monitor
  |     -> 40 ms capture quantum by default
  |
  +-- backing:stdin
        -> framed backing PCM
        -> Relay
```

`scripts/robot-source.sh` now holds a `flock` lock per sink. A second launcher for the same sink exits instead of creating a second Chromium/player/capture route.

The launcher also sets `RELAY_BACKING_ROBOT=1` for `backing:stdin`. The backing WebSocket therefore declares `robot: true` at registration time, before Chromium has finished loading. This is important: the server knows the route is a robot deployment early enough that the legacy song-content auto-calibrator cannot win a startup race.

An old Chromium process created before the single-instance/ownership changes cannot be remotely prevented from writing audio to PipeWire merely by ignoring its WebSocket telemetry. After deploying this head, use a clean launcher restart (or a clean host reboot) before the first hardware validation so no pre-update orphan browser is still feeding the sink.

## Calibration architecture

Robot timing is a three-term boot calibration:

```text
advance = micLatency - backingLatency + delta
```

- `micLatency`: known irregular three-note probe played by the phone and captured by its microphone.
- `backingLatency`: the same known probe played by the active robot browser and captured through the real Chromium -> PipeWire -> `parec` -> `backing:stdin` path.
- `delta`: active robot YouTube player position minus the phone-driven server timeline.

The probe reference is intentionally non-periodic so it does not have the beat-period ambiguity of correlating arbitrary songs.

### Calibration ownership

Robot and non-robot routes now have explicit ownership rather than sharing one ambiguous `CalibrationSession` policy:

- `calibrationKind = content` is the legacy song-content path for non-robot deployments.
- `calibrationKind = boot-probe` is authoritative on a robot route.
- robot backing registration suppresses legacy auto-calibration before the robot page says hello;
- pressing **Calibrate timing** on a robot restarts the two-leg boot probe; it never falls back to song correlation;
- a leftover content result is historical data only once the robot route exists and cannot become the mixer's active alignment.

### A boot result is not applied until all three terms exist

The two probe legs may complete before the robot player has a stable position. That is allowed, but an unknown `delta` is **not** treated as zero.

The mixer only applies a robot boot calibration when:

1. the measurement still matches the current session/mic/backing generations;
2. the result came from `boot-probe`;
3. there is one active robot source;
4. that source has published a fresh `robot-player-offset` within the freshness window.

Until then, the probe result remains inspectable evidence while the mixer uses the network fallback.

`source-status` / `timing-calibration-status` expose the distinction:

- `calibratedMicLagMs`: historical measured value;
- `activeCalibratedMicLagMs` / `activeMicLagMs`: value actually allowed to affect the mixer;
- `calibrationKind`: `none`, `content`, or `boot-probe`;
- `robotRoute`;
- `robotSourceConnected`;
- `robotDeltaFresh`;
- `timingMode`: `network-estimate` or `acoustic-calibration`.

A stale or incomplete result must never be inferred as active merely because a historical number is present.

## Robot source ownership

The server keeps one `activeRobotSource`, not a count of interchangeable pages.

When a newer `source.html?robot=1` connects:

- last connection wins;
- the previous page receives `robot-source-replaced`;
- the previous page parks itself: pause, mute, stop answering probes, stop sending delta, and stop reconnecting;
- backing probes are sent only to the active robot source;
- probe replies and `robot-player-offset` from any superseded socket are ignored.

The launcher-level `flock` is a second boundary. Protocol ownership prevents duplicate control/telemetry; the launcher lock prevents a second local browser from injecting duplicate audio into the same PipeWire sink in the first place.

## Delta lifecycle

`delta` is live timing evidence, not permanent calibration state.

`public/source.js` follows these rules:

- it only computes delta from fresh server timeline-status messages; there is no independent `setInterval(applyTimeline, ...)` replay of an aging `serverTime` snapshot;
- if a snapshot requires `seekTo()`, that same snapshot is not reported as a delta;
- after a seek, delta is suppressed for `ROBOT_DELTA_SETTLE_MS` (currently 1000 ms);
- delta is reported only while both desired and actual player state are playing and the source is armed.

The server treats a robot offset as fresh for 2000 ms. If it expires, or the active robot socket disconnects, the mixer withdraws the boot alignment and falls back to the network estimate. The measured mic/backing path terms are retained. Once a fresh delta returns, Relay recomputes the total from the existing path terms without replaying the audible phone probe.

A source seek or active-player replacement increments `sourceGeneration`; this prevents an old total from being presented as valid for the new player position.

## Probe lifecycle

A completed mic probe leg carries:

```text
sessionGeneration
micGeneration
targetSample
actualSample
correlation
```

Before the backing leg starts, and again before the two legs are combined, the session/mic generation must still match.

A stopped live session, changed capture generation, or incompatible probe state abandons the partial run. This prevents `Mic(A) + Backing(B)` from being stamped as a valid result for session B.

Mic/backing path measurements intentionally survive **player-only** churn once both legs have completed. A player reconnect/seek changes `delta`, not those two capture-path latencies.

## Where the old ~2 seconds came from

The large backing delay was two buffering/startup effects, both fixed rather than merely compensated:

1. `parec` was allowed to choose a ~2 second capture quantum. The launcher now requests `RELAY_BACKING_CAPTURE_LATENCY_MS`, default 40 ms.
2. `parec` began filling the FIFO while `npm`/`tsx` were still starting `backing:stdin`. The first transmitted frames therefore contained old startup audio but were anchored at their much later arrival time. `backing:stdin` now discards startup backlog for `RELAY_BACKING_STARTUP_FLUSH_MS` (default 250 ms) after the first byte arrives, then starts its sample cursor on live audio.

Observed before/after with a 400 ms live prebuffer was approximately:

```text
backing headroom: 1940 ms -> 360-400 ms
mic headroom:     1929 ms -> ~377 ms
```

The underlying browser/sink/capture audio path was about 51 ms after the capture-quantum fix (roughly 11 ms Chromium + 0 ms null sink + 40 ms `parec`).

The oversized `RELAY_MIC_RETENTION_MS=3000` and legacy `RELAY_CALIBRATION_MAX_LAG_MS=2500` remain conservative from the earlier multi-second-delay investigation. They are not the source of live output latency; retention primarily costs memory/search range.

## Capture generations

Phone capture generations are no longer a module-local counter that restarts from the same value after every page reload. `public/app.js` seeds the generation from the current clock and increments it for a new capture session before truncating to the uint32 wire value.

A WebSocket-only reconnect keeps the same generation and sample cursor, because the microphone capture itself continued. A true capture restart gets a new generation and invalidates timing evidence that depended on the previous microphone path.

The same framed-PCM rule applies to backing: sample indices continue through transport loss so missing network data appears as a hole rather than compressing the timeline.

## Legacy content calibration

Song-content correlation remains for non-robot deployments. It is no longer the primary robot timing mechanism.

The legacy path still has a provisional-confidence policy and a wide search range inherited from earlier development. Do not tune those values to fix robot calibration problems: if `robotRoute` is true, a content result should not own the mixer at all.

If legacy/non-robot calibration is revisited, the main remaining product question is whether a single-window provisional result should be allowed to apply before multi-window agreement when repeated musical beats can produce plausible aliases.

## Useful runtime values

Defaults currently worth remembering:

| Variable | Default | Purpose |
| --- | ---: | --- |
| `RELAY_LIVE_PREBUFFER_MS` | 400 | output delay / positive read-ahead budget |
| `RELAY_MIC_RETENTION_MS` | 3000 | retained mic history / negative read range |
| `RELAY_BACKING_CAPTURE_LATENCY_MS` | 40 | `parec` capture quantum on robot |
| `RELAY_BACKING_STARTUP_FLUSH_MS` | 250 | startup FIFO-backlog discard window |
| `RELAY_CALIBRATION_PROBE` | on | robot known-probe calibration |
| `RELAY_CALIBRATION_PROBE_RETRY_MS` | 6000 | retry spacing |
| `RELAY_CALIBRATION_PROBE_SEARCH_MARGIN_MS` | 3000 | probe path search range |
| `RELAY_CALIBRATION_PROBE_MIN_CORRELATION` | 0.5 | minimum accepted probe match |
| `RELAY_CALIBRATION_DELTA_REAPPLY_MS` | 40 | delta movement before changing applied total |
| robot delta freshness | 2000 ms | age after which the last player offset loses authority |
| robot seek settle | 1000 ms | client-side interval before delta resumes after a seek |

## Next real-hardware validation

After pulling this PR head on the Pi:

```bash
npm ci
npm run check
npm test
```

Then restart Relay and `npm run robot:source` from a clean process state. During the next sung recording, watch these fields together rather than judging from one calibration number:

```text
calibrationKind       expected boot-probe
robotRoute            expected true
robotSourceConnected  expected true
robotDeltaFresh       expected true while playing stably
timingMode            expected acoustic-calibration once delta is fresh
requestedMicAdvanceMs
appliedMicAdvanceMs   should equal requested unless a real buffer limit is hit
bootCalibration       inspect micLatency / backingLatency / delta separately
```

If audible sync is still wrong while those contracts remain healthy, the next investigation should compare the known-probe browser path with actual YouTube media presentation latency on the Pi. Do not return first to the already-fixed two-second FIFO/`parec` delay or to Cloudflare without new evidence.
