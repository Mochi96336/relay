# Choir: Stage 1 canonical MicTrack extraction

**Status:** Experimental Draft #576, stacked on #573 and #571. This is
**not** production-ready dual Mic. Do not merge while the single singer
remains unstable. **No automatic main-Mic succession**.

## What changed

`src/mic-track.ts` now owns nine per-singer component instances:

| Component | Role |
| --- | --- |
| `PcmTimeline` | Native captured PCM on the current room/sample timeline |
| `MicGainRamp` | Per-singer +24 dB default target and ramp |
| `MicLimiter` | Capture-local look-ahead dynamics |
| `MicRawMeter` | Capture-local input loudness |
| `CaptureRestartBoundaries` | Unheard restarts and semantic capture edges |
| `MicInputClipping` | Raw input clipping evidence |
| `SourceOutputEdge` | Missing/replacement audio fades |
| `MicFrontierCorrection` | Clock/frontier correction and loss folding state |
| `MicClockTrim` | Sender clock drift correction |

The experimental branch's canonical `AudioSession` constructs exactly one
`MicTrack`. Its existing methods still use the **same object instances**
through aliases. All ingest transforms, calibration/read-head motion, MixBus,
Robot backing and Take output calculation are unchanged.

This changes the **ownership boundary**, not the mixer algorithm. It creates
an actual reusable state bundle that can later be instantiated for B without
sharing A's gain/limiter/frontier/meters or source clock.

## Exact N=1 gate

The focused `.github/workflows/choir-experiment.yml` runs:

```bash
npm run check
node --import tsx --test --test-concurrency=1 \
  test/choir-*.test.ts test/mic-track.test.ts test/audio-session-golden.test.ts
```

The existing `test/audio-session-golden.test.ts` hashes the actual emitted
PCM frames, ingest outcomes, read positions, telemetry and evidence across
capture restarts, stalls, gaps, clock correction and other known scenarios.
A refactor that changes one of those observations should break an existing
Golden digest rather than quietly replacing the expected digest.

`test/mic-track.test.ts` asserts that two MicTrack objects have separate
timelines/gain/limiter/clock/restart/edge state. It also checks that the
actual AudioSession still ingests and reads the expected source PCM.

This is stronger than the earlier single-impulse position comparison:
**unchanged Golden digests provide bit-exact N=1 output/evidence regression
protection for their covered scenarios**. Passing them alone is not proof
that every mobile hardware failure mode is reproduced in tests.

## Stage 2: singer-local scalar state migrated into MicTrack

The canonical `AudioSession` now uses `this.micTrack.*` for:
- `alignmentState`, `calibratedMicLagTargetMs`, `calibrationUnfoldedSamples`;
- `lastEmittedMicAdvanceSamples`, `lastEmittedMicFrameComplete`,
  `lastEmittedMicSourceSample`;
- `micCaptureOriginSample`, `micLimiterResetPending`;
- `micStarvedFrames`, `micUnplayableRunFrames`, `micHeadroomMs`,
  `micConcealedSamples`.

These are not room-global concepts: two singers cannot share any of these
without contaminating the other's capture/calibration or health state.
This refactor keeps every existing computation in its original order;
`AudioSession` still emits exactly one Mic source. New isolation assertions
modify A's flags and verify that B's state remains at defaults.

## Stage 3: source-specific post-ingest processor

`MicTrack.observeIngest()` is now invoked by the canonical
`AudioSession.ingestMic()`. It owns capture-origin placement, detecting
source-clock continuity, collecting raw clipping evidence, queuing in-band
restart boundaries and updating the raw Mic meter. All of these operations
used to mutate those track-owned objects directly from AudioSession.

Crucially, `AudioSession.ingest()` remains the only packet placement path.
The track does **not** invent capture-to-room offsets or touch Robot backing.
`AudioSession` also continues to run its original same-capture gap
concealment and anti-click logic. The Golden PCM gate must remain byte-exact
over its existing restart, clock drift, clipping and packet-loss cases.

## Stage 4: canonical sample reads and evidence on MicTrack

The old `AudioSession.readMicFrame()` now runs as `MicTrack.readMicFrame()`,
along with its bounded-rate PCM read and immediate read-head crossfade helpers.
The **same existing** `readMicSlewedRange`, `crossfadeMicReadHeadJump`,
`readPcmRange`, `readPcmEvidence` and clipping/boundary code is called.
Only `MicTrack`'s own timeline, clipping and capture-boundary states are
accessible to this frame reader. The room retains timing planning and final
voice/backing mixing. No new producer or audio codec has been introduced.

`test/mic-track.test.ts` now asserts two independent MicTracks can return
different real PCM and missing-frontier evidence at the same room position.
Existing N=1 Golden PCM digests must stay untouched.

## Stage 5: remaining source-local continuity policy

The canonical `MicTrack` now owns the actual capture-restart seam decision
and `advanceCalibrationSlew()` policy. The room feeds the requested output
source position, but the singer's own last-emitted PCM source position and
queued restart boundaries decide whether its source transition begins.
No other singer's `SourceOutputEdge` is touched.
Readhead slew remains bounded by the unchanged per-frame percentage.
Added independent A/B calibration-slew and restart-seam tests.

## Stage 6: per-singer read planning and frontier budget

`MicTrack.planMicRead(startSample, expected)` now owns the canonical
`classifyMicReadMotion`, previously-emitted source trajectory, per-singer
alignment budget, frontier update and read-head crossfade evidence decisions.
The single room clock supplies only the frame start and whether that singer
is expected. The original `AudioSession` still calls
`foldConfirmedMicCaptureLoss()` first, preserving its timeline rebase and
capture-loss bookkeeping order. The room-facing advance getters delegate
to the same canonical MicTrack arithmetic (no duplicate formulas).

A/B regression tests compare two independent signed calibration values at
one room sample, plus one starved frontier with one healthy stream. They
cannot turn into two authenticated live Publishers until the current
AudioSession ingest/rebase and final mixer are separated and gated.

## Stage 7: track-local Mic headroom and starvation

`MicTrack.measureReadHeadroom(plan, expected)` now owns how much
source PCM the singer has actually delivered beyond the entire requested
read trajectory (including limiter lookahead and crossfade old leg). It
increments **that singer's** starvation counter only when expected.
`AudioSession.measureHeadroom()` retains room/backing headroom and backing
starvation, without mixing A's network quality with B's.

This remains an N=1 refactor; A/B isolation tests use distinct arrival
frontiers on the same room sample. No real second publisher yet.

## Still *inside* AudioSession and must be extracted next

The existing canonical methods continue to own:

- per-singer frame processing, source concealment application,
  input clipping and MixBus summing loop;
- the remaining Mic PCM transport placement in `ingestMic`,
  source sample-to-session mapping, trim/restart handling,
  `mixFrame`; `planMicRead` and `readMicFrame` now run on MicTrack.

**These must not be duplicated into the experimental ChoirAudioPrototype**
and silently bypass the actual single-singer correction code. The next
extract should carve out a per-track **ingest/read/evidence processor** while
leaving the room clock/Backing and final voice summing outside it.

A proposed intermediate internal boundary:

```text
Room AudioSession (one room output clock and Backing)
        │
        ├─ MicTrack A  [current canonical source pipeline]
        │    capture → timeline → clock trim → read motion → limiter → gain
        └─ (later) MicTrack B  [independent same pipeline]
                    ↓
              Voice bus → MixBus → Listen / Take
```

Before production dual Publisher admission:

1. Migrate one well-bounded existing Mic ingest/read responsibility per PR.
2. Check exact N=1 Golden PCM and evidence hashes **without** updating
   fixtures to hide unexpected changes.
3. Add independent B state to the same room timeline, and demand time
   mapping/authority isolation tests.
4. Integrate verified WebSocket/WebTransport media identity and per-singer
   Content/Sample/Boot applicability and safe read-head transitions.
5. Only then wire local YouTube follower and the small + Secondary Mic action.
6. Keep the primary seat vacant after its Mic grace expires. No auto takeover.

**Do not** interpret this state extraction as a reason to merge unfinished
Choir into `main`.

## Stage 6–7 CI audit: state-location-sensitive white-box tests

The full Relay CI surfaced six tests in `test/mic-read-plan.test.ts`
that assigned `lastEmittedMicAdvanceSamples` and
`lastEmittedMicFrameComplete` on the old `AudioSession` instance.
Those scalar properties now live on its `MicTrack`, so the test setup no
longer established the previous audible trajectory. The resulting six
crossfade/convergence assertions failed despite the existing N=1 Golden
PCM digests passing. The test-only state setup is updated to set
`session.micTrack.*` directly, matching the new ownership boundary.
No production compatibility scalar aliases are reintroduced.

The Choir focused CI now also executes `test/mic-read-plan.test.ts`,
so tests of previously emitted source continuity, old/new leg gap/frontier
gating and convergence cannot be missed by the smaller validation suite.


## Stage 8: source-native capture sample coordinates

The existing `AudioSession.micSourceSampleToSessionSample()` conversion
has moved to `MicTrack.sourceSampleToSessionSample()`. The same
`Math.ceil(sourceSample * roomRate / sourceRate) + originOffset`
arithmetic and rounding remain unchanged. `observeIngest` now asks
its own MicTrack for the source-native to shared-room coordinate when
collecting clipping evidence. It no longer takes an AudioSession callback
that could accidentally read another singer's capture origin.

Additional A/B tests use separate native 44.1-kHz origins against one
48-kHz room rate. This does **not** yet move the canonical PCM ingest
and resampler into MicTrack; the authoritative AudioSession.ingest()
still performs capture-clock anchoring to the room time.

## Stage 9: per-singer sample gain/limiter/source edges

The canonical output loop now calls `MicTrack.processVoiceSample()` for
its Mic gain ramp, capture-restart-limited lookahead detection, fresh
limiter seeding, peak limiting, missing-source envelope, and track-local
last-emitted source position. The method returns the already-processed
voice **plus** per-sample limiting evidence, which the current N=1 room
aggregates exactly as before. The shared `MixBus` still owns ducking,
backing, recording/monitor output and final clipping. The source processing
uses the same original methods and ordering; no separate simplified voice
pipeline is promoted to production.

The former `AudioSession.resetMicLimiterState()`, limiter seed helpers and
`restartBoundedDetectOffset()` now execute inside MicTrack. Tests check
that two track instances apply different gains independently, while the
existing N=1 Golden PCM captures any drift from the original limiter path.
