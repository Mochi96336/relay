# Canonical MicTrack N=2 Audio Experiment

**Status: Draft PR #576, experimental branch only. NOT shipped.**

This stage reuses the REAL MicTrack currently exercised by the single-Mic
AudioSession, rather than the earlier simplified ChoirAudioPrototype ring.

## Actual tested PCM path

```text
                          one room output sample index
                                      |
                  +-------------------+------------------+
                  |                                      |
      MicTrack(A).ingestCapture()             MicTrack(B).ingestCapture()
      real PCM resampling / capture clock     independent capture generation
      per-singer alignment & read head        independent Content lag / trim
      real gain / limiter / edge              independent source evidence
                  |                                      |
          fixed two-slot voice headroom: each bounded to 0.5 * Mic ceiling
                  +-------------------+------------------+
                                      |
                                   MixBus
                              ONE canonical backing
                                      |
                             quantized output PCM
```

`src/choir-canonical-mix-experiment.ts` is an offline deterministic test
room. The generic PCM ingest and the actual source-specific processing use
the same extracted implementations used by the existing N=1 AudioSession.
The final `MixBus` object is the production one. **No production
server imports this experiment**; the actual live N=1 AudioSession
MixBus and its Golden PCM output are unmodified.

## What CI now verifies

- Independently placed Mic A **+120 ms**, B **−340 ms** capture-native
  impulses arrive at the same room sample. The B fixture includes a short
  real source onset before its impulse, so the canonical missing-to-real
  SourceOutputEdge completes its intended anti-click fade. Both the read
  coordinates and the processed voice peaks are asserted. A-only reference
  output proves B contributes to the actual mixed PCM, not just its marker.
- A genuine positioned 960-sample hole stays visible in **A's** capture
  evidence even when the pitch-concealment algorithm synthesizes audio;
  B's PCM and sample-gap evidence remain independent and audible.
- Disconnecting A blocks future A frames. A may finish its already buffered
  tail without dropping B; B does not become the primary Mic. Stale song,
  backing and media epochs are rejected by the test harness.
- Two sources at default **+24 dB** Mic gain with near-full-scale Backing
  exercise both Mic limiters. A finite attack can overshoot the nominal
  −1 dB ceiling (119 final-output clips observed in the initial unfenced
  N=2 prototype). The experimental fan-in **bounds each singer's
  contribution to the ceiling** and exposes `limiterOvershootSamples`
  per singer rather than hiding it in the final clamp. This is a bus guard,
  **not a fix to the original N=1 limiter or an acoustic optimization**.
- B arriving after A is already audible uses its own 10ms entry gain,
  because `MixBus` only understands a group Mic and cannot start a join
  crossfade on a second singer. A's source edge is not restarted.
- Room output sample numbers are contiguous and forward-only. N=2
  source-order-independent mix and per-singer evidence are tested.

## Explicit limitations and blockers

1. **No authenticated two-Publisher transport.** The harness takes an
   `id` object from its test caller. Production must supply identities and
   media epochs from trusted server admissions; an arbitrary client-asserted
   participant ID or media epoch is not authorization.
2. **No real live timing/transport deadline.** Preloaded PCM and a manually
   advanced room frame are deterministic; a server must enforce late-packet
   cutoffs, jitter/deadline behavior, per-singer sample mapping and drift.
3. **No production calibration coordinator.** Only the first pre-render
   externally confirmed signed lag is accepted. There is deliberately no
   live hard-jump, Content stale-result admission, safe backup switching,
   listening/YouTube follower or route-epoch invalidation in this harness.
4. **Not N=1 bit-exact when using this experimental N=2 room**. The
   dual-singer voice is deliberately fixed to two half-ceiling slots,
   even when only A is present, to prevent a level jump when B joins.
   Existing production N=1 AudioSession remains unchanged and guarded
   by its Golden PCM suite.
5. **Not a production Listen/Take implementation.** The N=2 test reports
   per-singer evidence in its own type, but real `MixFrameEvidence`,
   recorder provenance and monitor forwarding have not been migrated.
6. **No UI**. The small '+ Secondary Mic' action remains disabled/absent
   from the deployed browser. No automatic main Mic promotion.

## Next safe milestone

Build a server-harness boundary with **verified transport admission** and
session-native capture sample mapping, then drive two canonical MicTracks
through a real deadline-driven output scheduler. Only when each singer's
Content/fallback authority, Listen and Take provenance are enforced can this
fan-in replace or extend a deployed N=1 AudioSession.

All three stacked PRs (#571, #573, #576) stay Draft until N=1 is stable.


## Ingest provenance fencing (still offline only)

The N=2 test room now refuses unpositioned PCM packets, non-finite or
negative source indices/generations, more than two source seconds in one
packet, fully duplicated intervals, backwards capture generations and an
established capture source timestamp mapping over two seconds ahead of
server room time. It compares a proven native source origin after conversion,
not to zero: a capture whose absolute sample count starts after an hour is
still valid when correctly anchored to the room. Both Media Epoch and song
Epoch are checked before any packet enters the canonical MicTrack.

These are preliminary *harness* admission guards. A deployed server must
use authenticated transport/media epochs and stronger source rate, packet
size and real-time scheduling policy. This code is not loaded by server.ts.


## Media epoch restart does not reuse an acoustic calibration

The offline canonical room can now safely replace an already disconnected
singer after the old audio tail and source output fade have **finished**.
A fresh `MicTrack` starts muted while the new media epoch awaits an
externally verified Content or Sample/Boot fallback decision.
`awaitingCalibration` is available per-singer in frame evidence.
The ordinary room's N=1 path, older canonical N=2 tests and B's capture
remain separate. The reconnect test deliberately prebuffers real source
PCM before demanding a visible signal, rather than disabling the existing
Mic frontier safety correction to make an undersupplied sample audible.
