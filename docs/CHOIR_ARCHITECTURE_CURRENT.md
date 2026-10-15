# Choir #576 — current architecture and cleanup map (2026-10-15)

**Scope:** Draft experimental branch only. Not released to normal Relay, and not
safe to enable N=2 Monitor, Take or recording yet. No primary Mic automatic
succession in v1. See `docs/CHOIR_REVERSE_AUDIT.md` for release risks.

## Actual default-off live path

```text
Authenticated A + B consent + trusted SongSession + Robot control
  -> ChoirRoomRestartCoordinatorExperiment (approved fresh Room/Song Epoch)
       -> ChoirFreshRoomHandshakeExperiment (server-issued A/B Media Epochs)
            -> ChoirDeadlineRoomExperiment (trusted deadline / proof policy)
                 -> CanonicalChoirMixExperiment
                      -> MicTrack(A), MicTrack(B), MixBus
  -> A existing production Mic publisher -> ChoirTrustedSourceMirrorExperiment
  -> Robot existing production Backing -> ChoirTrustedSourceMirrorExperiment
  -> B independent AudioPacket v2 WS -> ChoirSecondaryMediaTicketExperiment
       -> ChoirSecondaryPcmIngressExperiment
  -> bounded six-second source-authentic Content PCM
       -> ChoirLiveContentPipelineExperiment -> isolated Worker
            -> timing-calibration analyzer
       -> coordinator re-validates authority -> per-singer Content-ready

  Experimental rendered duet PCM is discarded, NOT sent to N=1 Monitor/Take.
```

- `src/server.ts` runs those paths only when BOTH `choirShadow` and
  `choirMediaExperiment` are enabled.
- `ChoirShadowLifecycleExperiment` and
  `ChoirSongSessionBridgeExperiment` maintain separate, conservative
  SongSession/Robot authority witness; the FreshRoom owns the actual duet.
  Do **not** collapse these two boundaries without equivalent stale/Seek and
  failed-restart coverage.
- The three sources share one server-owned playback clock but each singer
  retains its own Mic Capture/Media Epoch, native PCM and Content result.
- A successfully authorized Content result is **not** a permission for B to
  publish as a normal N=1 Mic, nor a permission to record Choir audio.
- Worker's `tsx` dynamic import is isolated; the full `node --test` runner
  must also prove it can start and commit the real analyzer.
- The shared `ChoirAlignmentDecision` contract now lives in
  `src/choir-alignment-decision.ts`, independent of a model implementation.

## First-generation prototype retired

The old `src/choir-audio-prototype.ts`, `src/choir-read-plan.ts` and
`src/choir-alignment-bridge.ts` used a separate synthetic PCM ring and
read-anchor mapping. They were NOT imported by the current server or the
canonical mix. Their matching first-generation tests were removed after
cross-checking CanonicalChoirMix, MicTrack, DeadlineRoom and socket regressions.
The original design narrative remains in `CHOIR_AUDIO_PROTOTYPE.md`
as archived history, not executable documentation.

## Experimental / offline-only logic still retained

- `ChoirCalibrationExperiment`: first-generation isolated Sample/YouTube and
  Boot fallback estimator with distinctive device-aware tests. **Not wired
  to the live Worker path.** Preserve until corresponding real fallback
  authority, timing and handoff cases are migrated.
- `ChoirFollowerPolicy` and `projectChoirMicActions`: pure policy/UI
  projections not invoked by the current browser `choir-consent-ui.js`.
  Do not label their unit tests as evidence of a complete follower UI.
- `ChoirDeadlineRoomExperiment.analyzeTrustedCanonicalContent` is an
  offline synchronous testing oracle. **Live analysis must remain off-thread**
  through `ChoirLiveContentPipelineExperiment`.
- B's `ChoirSecondaryPcmIngressExperiment` is now strictly AudioPacket
  **v2 only**, both when called privately and from the actual server. The
  retired v1 decoder no longer exists on the B path; tests still send v1
  bytes to verify explicit downgrade rejection, and preserve capture,
  replay/reorder, rate-limit, stale-room, and Seek quarantine cases.
- Shadow's own witness room and FreshRoom's duet output room are separate
  objects on purpose at present. Consider consolidation only after a
  stronger equivalence proof, not simply due to duplicated nouns.

## Do not treat safety barriers as duplicate business logic

A/B consent, one-use claim, socket binding, packet identity, Coordinator
authority observation, Worker result acceptance and acoustic proof commit
each defend a **different race boundary**. They must remain even if the
same epoch or identity appears repeatedly. Keep source history independent
from N=1 playback retention and disallow forged zero-filled Content windows.

## Gates before releasing any actual Choir mix

1. All focused Choir CI, Golden N=1 audio, production-browser audio and full CI
   pass on the **same head** after cleanup.
2. Verify real phone A/B capture clock behavior, local YouTube playback drift,
   Bluetooth/earphone path effects, and extended network jitter/drops.
3. Wire an explicitly separate, permission-gated duet Monitor/Take path and
   prove N=1 output byte-exact with both flags **off**.
4. No automatic A takeover, even if A disconnects while B is still connected.

The historical PR log and large timeline design document are references,
not a checklist of currently shipped features.
