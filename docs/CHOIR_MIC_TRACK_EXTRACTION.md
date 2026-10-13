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

## Still *inside* AudioSession and must be extracted next

The existing canonical methods continue to own:

- per-singer frame processing, source concealment application,
  input clipping and MixBus summing loop;
- `ingestMic`, source sample-to-session mapping, trim/restart handling,
  `planMicRead`, `readMicFrame`, and `mixFrame`.

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
