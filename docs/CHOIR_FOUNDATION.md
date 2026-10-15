# Choir / secondary Mic — experimental foundation (Draft only)

> **Historical foundation; not an accurate current integration status.**
> This branch now has gated A/B/Robot WebSocket Content calibration, but
> still has **no** N=2 Monitor/Take output. See
> [CHOIR_ARCHITECTURE_CURRENT.md](CHOIR_ARCHITECTURE_CURRENT.md).
>

This is **not** a production-ready feature. All new code is deliberately
unreferenced by `src/server.ts` and the browser. The normal single-Mic path
must keep working and need not merge this branch while it remains unstable.

## Decisions fixed for v1

- Keep the existing main **Take Mic / Take Over Mic** affordance.
- Only while a main Mic exists, show a small **+ Secondary Mic** action beside
  **Take Over Mic**. Secondary joining is additive; it never steals the main Mic.
- Each singer runs their *own* YouTube audio locally. One authorized controller
  governs the **room song intent**. Local follower observations must not write
  the authoritative SongSession clock.
- Main and secondary are **control roles**, not voice volume multipliers.
- **No automatic main-Mic succession in v1.** If main Mic leaves, secondaries
  keep their own media and calibrations. The primary seat stays vacant until
  someone *explicitly* takes it.
- Disconnect is not release: preserve each Mic seat through its *own* bounded
  reconnection grace. Only an explicit leave or expired grace calls
  `leaveSinger`.
- Mic loss never implicitly reassigns song control. Song handoff is a separate
  confirmed action; if the playback controller disappears, its clock cannot be
  silently replaced with any secondary's unvalidated YouTube telemetry.
- In the first experiment allow at most **two simultaneous singers** (1+1);
  make this configurable later.
- Singers hear their own YouTube, not Relay's returned room mix. Continue
  protecting against acoustic echo/feedback.
- Content correlation is the preferred *measured* alignment; Sample/YouTube
  remains explicitly an estimate. Boot multi-singer sound probes are out of
  scope initially.
- Use one shared room output clock; each singer owns an independent capture
  epoch, media runtime, read head, drift state, gain, and Content result.
- Cap live room output holdback; a slow singer is muted/faded independently,
  never allowed to stall all participants. Exact holdback is a measured tuning
  parameter, not a fixed claim.
- Keep final Listen and Take as one authoritative mix. Per-singer Take quality
  evidence is required before claiming a Choir Take is clean.

## This first change actually implements

1. `ChoirSession`: explicit main/secondary seats, independent song controller,
   optimistic takeover check, idempotent joins, explicit release, **no automatic
   promotion**. Its callers must perform participant authorization and transport
   grace enforcement; this pure policy does neither.
2. `planChoirRead`: a small sample-position mapper and generation fence. It
   consumes already-confirmed anchors; it does NOT discover them from Content,
   process samples, or mix audio.
3. Unit tests for main loss while two secondaries continue, deliberate
   promotion, CAS stale takeover, separate song handoff, source-rate mapping,
   mismatched participant/generation, and signed preroll.

**No live Choir functionality exists after this PR.** In particular no UI
control is mounted, no second publisher is admitted, and no audio is mixed.

## Next isolated PRs (each stays Draft until single-Mic regressions settle)

1. A dual-singer **Content analyzer proof**: use existing multi-band music
   fixtures and the real analyzer to produce each anchor. Record absolute
   signed error for simulated 0, ±300 and ±500 ms offsets and fail if the
   chosen correlation window produces an unsupported result. Distinguish
   alignment *accuracy* from live *arrival deadline*.
2. Extract a single `MicTrack` with `N=1` golden-PCM parity against the
   current AudioSession. Do not change SongSession or the deployed mixer yet.
3. Prepare follower YouTube playback control and local playback-observation
   events; never send follower observations as authoritative
   `youtube-telemetry`.
4. Add singer-scoped microphone admission, media ticket routing, transport
   grace, drift, gain, Content state, and independent loss handling behind an
   explicit experimental gate. Preserve old single-Mic registration semantics.
5. Add bounded multi-voice mixer and per-singer health/Take evidence.
6. Add the compact secondary button to the existing Mic actions row; only
   expose when the backing service, follower playback and media backend are
   ready. Test physical Android and iOS Safari.

## Critical regression invariants

- No importing these experimental modules from production code before the
  related feature gate and integration tests exist.
- An expired/failed *primary* transport cannot revoke a secondary's lease,
  capture, clock, gain, or Content result.
- An expired/failed *secondary* transport cannot reset the primary's timeline.
- No automatic succession, even after grace expiry. An explicit Take Mic action
  may upgrade an already-connected secondary without restarting their stream.
- A room YouTube command is authorized by song-controller identity, never by
  "the last singer who sent telemetry".
- AudioPacket framing, Robot backing, existing Take writer and single-Mic
  calibration logic remain untouched until explicit tests justify a change.
