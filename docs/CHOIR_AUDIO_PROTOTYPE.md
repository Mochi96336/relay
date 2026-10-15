# Choir PCM prototype — playable two-singer timeline (stacked Draft)

> **Archived first-generation design (not current executable code).** The
> synthetic `ChoirAudioPrototype`, `choir-read-plan.ts` and
> `choir-alignment-bridge.ts` were retired during #576 cleanup. For the
> current implementation and release gates, see
> [CHOIR_ARCHITECTURE_CURRENT.md](CHOIR_ARCHITECTURE_CURRENT.md).
>

**Depends on Draft PR #573, which depends on Draft PR #571. Not on main.**
The user's single-Mic Relay remains the stable interface; DO NOT merge the
experimental stack before the single-Mic runtime is trustworthy.

This revision adds real, deterministic sample movement and final mixing
rather than only calibration arithmetic:

- `src/choir-audio-prototype.ts`: independently allocated bounded native-rate
  Mic PCM rings (one per participant/capture generation), per-singer read
  anchors, fractional interpolation, no stale ring wrap, earliest valid PCM
  packet wins on overlap, irrevocable output frontier, and per-singer fade
  when source data is missing.
- One shared, monotonically advancing room output sample position.
- A fixed deadline (100 ms only for the synthetic tests; actual choir latency
  requires physical measurements). When a Mic has no data at that deadline,
  the room outputs everyone else on time and reports a *per-singer* gap.
- Real `MixBus` integration: each singer is bounded by 0.45 full scale, with
  at most two singers and a declared voice ceiling of 0.9. Sum headroom and
  backing duck/join protection remain owned by the existing MixBus.
- `src/choir-alignment-bridge.ts`: turn a **validated** Content or explicitly
  selected Sample/Boot result into a native Mic read anchor using an external
  zero-advance native capture mapping. It deliberately cannot guess such a
  mapping from YouTube position or network packet arrival.
- Tests exercise aligned +300 ms singers, actual Int16 PCM, late packets,
  fixed deadlines, remove-primary without stopping B, stale generations,
  fractional 44.1k/48k reads, redundant packets, missing source and Sample
  fallback producing *audible* signal, not just numeric decisions.

**Non-goals / unresolved:**
- No real WebSocket or WebTransport route connected yet. Existing single-Mic
  `AudioSession` is unchanged and still owns production monitor/take.
- The prototype is mono PCM only; it does not implement actual codec,
  sender retransmit, capture clock trim, drift tracking, true room/song
  timestamp establishment, live Content authority approval, per-singer
  limiter, adaptive gain, or echo cancellation.
- A 100-ms test holdback is not a recommendation for production; 600-1000 ms
  is an experiment range, subject to measured device latency and network.
- The room must be driven by an explicit trusted shared output clock.
  One YouTube follower's telemetry must never replace that clock.
- Real fallback quality is device-dependent; a Sample estimate can be better
  than Boot. Neither is automatically as reliable as confirmed acoustic
  Content. Do not apply fallback in response to transient `hold` states.
- `ChoirAudioPrototype` does not infer participant permissions from a packet.
  The production integration must first enforce `ChoirSession` authorization
  and per-publisher cryptographic/media-ticket identity.
- **No automatic main Mic succession**. Losing A's primary transport cannot
  release B or silently make B the new controller.
- The requested small "+ Secondary Mic" button should be wired only when real
  dual Mic admission, follower playback and authoritative mix are operational;
  no dead button is shipped.

Follow-up boundary: integrate one MicTrack behind N=1 Golden PCM parity, then
independent connection admission+source monitoring, then combine the tracks
inside the canonical room Mixer, while retaining all mainline regression tests.

The final test also runs both 6-second production Content analyses (+120/-340ms),
explicitly confirms each candidate, converts the resulting independent lags
into native capture read anchors, emits real PCM through one MixBus, and proves
that a subsequent primary-Mic departure leaves B in the secondary seat.
