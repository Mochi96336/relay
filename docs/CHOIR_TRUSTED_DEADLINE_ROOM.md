# Choir: trusted transport, fixed-deadline N=2 server experiment

**Status: experimental Draft #576 only. Not connected to the deployed Relay
WebSocket/WebTransport handlers or Listen/Take. Do not merge while N=1 is
unstable; no automatic main-Mic succession.**

This stage builds on the canonical two-Mic `MicTrack` / `MixBus` offline
experiment (not on the older simplified ring-based ChoirAudioPrototype).

## Trust boundary

```text
existing server private capability verification (NOT implemented in this PR)
                       |
         verified participant + live socket id
                       |
          ChoirPublisherRegistry.admit()
                       |
         server-owned mediaEpoch and seat
                       |
            ChoirDeadlineRoomExperiment
                       |
   receiveFromTransport(socketId, PcmFrame, sourceRate, nowMs)
                       |
  registry.activePublisherForTransport(socketId) ONLY
                       |
  CanonicalChoirMixExperiment.ingestMic(server-computed identity)
                       |
   singer-owned MicTrack and one canonical MixBus
```

**No PCM packet may supply or select `participantId`, `seat`, `mediaEpoch`,
`songEpoch` or `backingGeneration`** in this experiment's ingress API.
The receiving socket identity comes from the server adapter. The admission
method takes `verifiedParticipantId` **only after** the existing private
capability has been checked by the server; simply naming oneself is not
authentication. No such adapter has been wired into production yet.

The room, admissions registry and seat state are private to the coordinator;
diagnostics return copies and cannot issue admission or audio mutations.
The server may call `receiveTrustedBacking()` only from its already trusted
Robot/Backing media route, not an arbitrary web client.

## Fixed output deadline contract

The clock is one server-owned monotonic wall clock translated into one
mix-rate sample clock (48,000 samples/s in the tests). Frames are
20 milliseconds / 960 samples. A configured holdback is added *after*
the complete frame's clock interval:

```text
song room epoch                 t=0
song sample 0..959              t=0..20 ms
output deadline for that frame  t=20 ms + 200 ms holdback = 220 ms
song sample 960..1919           t=20..40 ms
next deadline                   t=240 ms
```

- `renderDue(219.999)`: emits nothing.
- `renderDue(220)`: emits room frame `[0,960)` **once**.
- `renderDue(240)`: emits room frame `[960,1920)` **once**.
- Calls cannot rewind or skip the next committed output sample.
- More than `maxCatchupFrames` due at once (default 8), or a regressing
  server time, latches `resync-required`; it does not replay a backlog of
  old singing and does not resume itself after recovery.
- A Mic packet whose **mapped source end is already behind the last
  emitted Mic read frontier** is rejected, even if it had never reached
  `ingestPcmTimeline`. Every singer exposes their own `latePacketDrops`
  diagnostic. Duplicates, stale capture generations, pathological future
  timestamps and oversize PCM were already rejected in the N=2 fan-in.
- A server-side new song/room epoch must establish a new coordinator after
  a hard deadline failure. Do not treat the old capture/media epoch as live.

The test scheduler uses a caller-supplied `nowMs` to make time deterministic.
**Real event-loop jitter, network delivery deadlines, clock-jump handling,
monitor playback and timers are not validated yet.** None of the simulated
clock arguments are obtained from an untrusted PCM payload.

## Primary/secondary behavior

Two explicit admissions yield two independently fenced media epochs.
`disconnectTransport(A)` makes A unavailable and leaves B streaming as
secondary, even after A's grace expires. It never promotes B or transfers
song control.

`takePrimaryTrusted(B_transport, expectedPrimaryId, nowMs)` is an **explicit
authenticated control action**, not an automatic disconnect handler. It
requires a fresh compare-and-swap of the observed primary; on success A's
media admission is revoked while B's captured stream remains in place.
The original song controller is unchanged. Already retained A audio may
finish its own edge; real policy for retiring any non-emitted A tail on a
host handoff still needs validation before the live integration.

## Deliberate fail-closed limitations

- Reattaching an existing singer through a new transport is currently
  rejected with `rebind-deferred`: retaining previous PCM through a new
  media epoch without clicks, mis-replay or calibration contamination is
  **not solved**. Reconnect is therefore not a shipped feature of this
  coordinator. Existing N=1 reconnect behavior is unchanged.
- `CanonicalChoirMixExperiment` remains a deterministic test room, not
  a replacement for production `AudioSession`. Its N=2 headroom and fade
  can differ from N=1; the existing Golden PCM suite protects the latter.
- The room only accepts one externally verified signed lag at initial
  setup. **Live Content candidate filtering, Sample/Boot backup, stale
  calibration generations and YouTube follower local state are not wired**.
- The test returns `CanonicalChoirFrame` with per-singer evidence, not the
  production Take recorder's evidence contract. No live Monitor or Take output.
- The actual production transport handler must establish the identity binding
  from its existing private capability and ensure the `transportId` is
  assigned by the socket server, never copied from a client request body.
- Late-source guards are keyed to the current captured source generation;
  reordering/overlap inside a partially consumed packet and full-room
  deadlines across generation changes still need adversarial tests.

## Verified by focused CI

`test/choir-deadline-room-experiment.test.ts` runs through the
Choir contracts gate alongside existing N=1 Golden PCM. It covers:

- A/B separately verified sockets, real canonical N=2 output PCM and exact
  frame due times with no repeated samples;
- unrecognized/closed/replaced socket rejection;
- explicit B Take Mic CAS (never automatic) and independent song authority;
- fail-closed reconnect until capture-tail replacement is available;
- bounded timer backlog and wall-clock regression latching;
- already-emitted PCM rejecting late A input without affecting B;
- rejecting seat impersonation from media traffic.

## Next integration gate

Implement the real **server adapter** against the existing private
authentication and media transport, then choose a safe reconnection
lifecycle and N=2 Take evidence contract before enabling even a small
'+副 Mic' button in the UI. Two-device Content plus backup calibration
and packet-loss/deadline rehearsal are mandatory before shipping.
