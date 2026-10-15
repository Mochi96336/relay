# Choir: trusted transport, fixed-deadline N=2 server experiment

> **Chronological engineering log, not a statement that every past
> phase is still in use.** The current live experimental architecture,
> retired prototypes and unresolved release gates are summarized in
> [CHOIR_ARCHITECTURE_CURRENT.md](CHOIR_ARCHITECTURE_CURRENT.md).
>

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

- A new socket for the **same disconnected singer** is rejected with
  `rebind-deferred` **while old captured PCM or its output fade is still
  audible**. After the old source read head has passed the captured tail and
  reached silence, an explicit registry admission grants a NEW server
  `mediaEpoch`, atomically replaces only that singer's `MicTrack`, resets
  gain/limiter/clock/PCM and preserves B's independent capture.
- The new Mic remains **muted** after admission. Even if it has PCM, only a
  `ChoirAlignmentDecision` supplied through
  `acceptTrustedReboundAlignment` with a currently admitted transport/media
  epoch and an accepted `content`, `sample-song-estimate` or
  `boot-probe-estimate` may unlock it. `content-held`, `unavailable`,
  mismatched epochs and replayed decisions cannot unmute it. An upstream
  trusted calibration runtime must establish fresh evidence identity and
  validity before invoking this server-only method; this coordinator
  **does not itself authenticate or validate raw Content/Boot candidates**.
- This gated rebind is a deterministic **prototype**, not a shipped
  reconnection guarantee. It can defer past the configured reconnect grace,
  in which case the publisher registry requires a fresh explicit seat claim.
  Seamless phase-continuous live crossfade or auto-reconnect while both old
  and new publishers overlap is intentionally not implemented. Existing N=1
  reconnect behavior is unchanged.
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


## Event-order deadline closure (subsequent hardening)

The deadline coordinator now calls `sealDueNow(nowMs)` **before every**
trusted admission, Take Mic, disconnect, Mic packet and Robot Backing packet,
as well as at `renderDue`. Already due frames are frozen in a bounded
private FIFO and delivered only once to the output sink. If a 220ms frame
expired at wall time 220ms, a Mic packet arriving at 221ms cannot alter it
even when the output callback itself was delayed until 221ms. A test
intentionally omits the 220ms render call and verifies this exact race.

Both new frames waiting to seal and already sealed-but-not-drained frames
count against the maximum pending limit. Going over that limit latches a
fresh-epoch requirement and drops stale pending PCM. This remains a pure
deterministic test scheduler: production still must provide a reliable
monotonic clock and output sink.


## Gated capture rebind and replay isolation

For a **previously authorized/audible** A, retained PCM finishes under the
original MixBus and MicTrack read deadline. A subsequent verified new transport
can reclaim that singer slot only when `edge.silenced` is true and
`lastEmittedMicSourceSample` has passed the captured frontier. An uncalibrated,
never-authorized rebound is a separate case described below. The old MicTrack
object is discarded; B's seat, PCM and media epoch do not move.

The replacement starts with `awaitingCalibration = true`, and the
canonical mixer does not emit its voice or commit an audible read-head
history until **new-capture** Content/Sample/Boot authority is provided.
An acoustic decision may be accepted only once per rebind. All earlier A
credentials and decisions are fenced. A source with insufficient received
PCM still obeys the existing 200ms Mic frontier cushion; neither
authorization nor timestamp math can conjure missing packet samples.

The offline tests cover rejection before old-tail retirement, new Media
Epoch and Capture reset, old transport rejection, B continuity, held/
unavailable/stale decision rejection, and the new source becoming audible
only after a fresh accepted decision and real PCM has arrived.

## Repeated rebind and calibration-source transition gates (2026-10-14)

The A → A2 → A3 regression revealed a special case: A2 may be admitted,
buffer real PCM, but disconnect **before its PCM ever becomes audible**.
An uncalibrated mixer bypasses the per-sample voice processor; an already
authorized replacement can likewise disconnect between its calibration
acceptance and the next output tick. Both cases have zero join gain and no
emitted source-read history. Such a never-rendered MicTrack may be discarded
even if it held buffered PCM. This does **not** relax the tail/frontier and
SourceOutputEdge requirements for any MicTrack that emitted a voice. A3
receives a new media epoch and cannot inherit A2's PCM or calibration.

Calibration authority must be distinguished from PCM availability:

1. A fresh Content/Sample/Boot decision may clear `awaitingCalibration`
   **only after at least one native positioned PCM packet established the new
   Capture Generation and source rate**; otherwise authority would be bound to
   null and become impossible to revalidate. Authorization does not bypass
   source placement, prebuffer or Mic frontier protection.
2. `content-held` is *not* a backup signal or audible authority, even if it
   carries the last known Content advance for diagnosis.
3. A Content `revoke` invalidates its previous confirmed authority. The
   separate calibration experiment may then choose a fresh Sample/Boot
   estimate; this is not an automatic live mixer switch.
4. Sample and Boot differ across devices: neither is presumed more accurate.
   A live coordinator must validate capture identity, generation, measured
   freshness and fallback provenance before passing a trusted decision.
5. Once audible, a subsequent alignment change must use the separate
   read-head safety/revalidation protocol. Do not automatically jump from a
   fallback position to recovered Content and do not treat a diagnostic
   residual as permission to shift samples.

**Remaining release blocker:** the trusted server calibration proof adapter,
including per-media-epoch identity and independently verified Content/Boot
evidence, is not wired. The offline coordinator accepts already-authorized
decisions, not raw client evidence. These policies and tests must not be
misreported as end-to-end authenticated live calibration.

## Live fallback-to-Content recovery: gated, not an instant reposition

The *offline experimental* trusted deadline coordinator now offers
`acceptTrustedLiveContentRecovery(transportId, mediaEpoch, proofRevision,
decision, nowMs, takeFrozen)`. This is **not** a WebSocket RPC, and does
not collect or authenticate Content evidence. The eventual server adapter
must derive the transport, media epoch, monotonically ordered proof revision,
and Take-freeze state from its OWN trusted sources, not untrusted client fields.

This narrow proof handles a singer who rejoined, obtained fresh Sample or Boot
authority, and is already audible when **new verified Content** arrives.
The initial rebound alignment remains valid throughout a rejected recovery.

The request is rejected unless all of these hold:

- Current authenticated/connected transport and identical media/song/backing
  epochs; the singer is not disconnected, awaiting initial calibration or in Take
  freeze; the prior admitted source is an actual Sample/Boot fallback.
- A new positive, monotonic revision and accepted `content` decision with a
  finite bounded signed advance. Held, missing, replayed or wrong-source
  decisions cannot promote themselves.
- Same native capture generation and source rate that established the rebound
  authority; MicTrack's earlier correction finished, and its previous audible
  frame was PCM-complete.
- Both the *old* and the proposed source read windows, including limiter
  look-ahead, contain **real retained PCM**, not a gap or missing frontier.
- The target differs by at most 5 ms from both the current target and the
  rebound's **original** trusted lag. This last check blocks a staircase of
  small proofs from accumulating into a large jump. The target must fit the
  existing prebuffer/retention budget. The 5 ms guard is experimental and
  is **not** a measured device tolerance or a production latency claim.

After acceptance, only `MicTrack.calibratedMicLagTargetMs` changes; the
canonical MicTrack algorithm advances the applied lag by at most 1% of a frame
duration per output frame (0.2 ms for a 20 ms frame), with its existing
fractional PCM read, frontier protection and limiter. No new read-head DSP
path was added. The per-singer output evidence now distinguishes
`calibrationSource` (**newly authorized target source**) from
`calibrationAppliedMs` (**lag used by this frame**) and
`calibrationTargetMs` (**eventual requested lag**). During slew these values
are intentionally different.

A disagreement larger than the bounded window **remains on the last known
fallback**. Explicit, separately proven reacquisition or a new safe epoch
is still needed. This experiment intentionally does not implement automatic
primary-Mic succession, live fallback demotion, large-lag crossfade, or a
verified physical two-phone calibration adapter. Existing N=1 audio processing
and deployed server routing are untouched.

## Large Content disagreement: explicit reacquisition, never an audible jump

The previous bounded live-recovery rule remains the fast path for differences
inside the experimental 5 ms guard. Larger differences (for example, an
already-audible Boot estimate of +120 ms versus new verified Content at +180 ms)
do **not** change the currently applied Mic lag.

The offline trusted-coordinator contract is:

1. `requestTrustedLargeContentReacquisition(transportId, mediaEpoch,
   proofRevision, contentDecision, nowMs, takeFrozen)` may stage exactly
   one outstanding large disagreement on a **verified, still-connected**,
   already-audible Sample/Boot rebound capture. It requires a complete
   previously emitted Mic read and an active source join fade, plus the same
   singer epoch/capture generation as the established fallback; held Content,
   duplicate/replayed revisions, Take freeze, nonfinite data and small
   differences are refused. This is an intent, not a replacement of the
   active Mic read head or permission to reuse the candidate as authority.
2. While staged, that singer **keeps using the original fallback**. Its PCM,
   limiter, gain, source clock and per-singer evidence remain unchanged.
   A subsequent small Content proof cannot bypass the staged requirement.
   The other singer, room clock and Robot backing remain untouched.
3. The user/coordinator must **explicitly disconnect** the old publisher;
   the existing immutable deadlines consume its previously admitted PCM
   and complete the SourceOutputEdge fade before another Media Epoch may
   reclaim the same singer seat. A slow tail can outlive reconnect grace;
   when that happens the existing explicit-seat-claim rule still applies.
4. `replaceDisconnectedSinger` creates a completely new MicTrack. When the
   predecessor had staged a large reacquisition, the new slot records
   `requiresFreshContent=true` but does **not** inherit its earlier
   target, residual, cached PCM or acoustic proof. The ordinary fallback or
   initial Content admission method cannot clear this gate.
5. Only `acceptTrustedReacquiredContent(transportId, mediaEpoch,
   { mediaEpoch, captureGeneration, revision }, contentDecision, nowMs)`
   can authorize this slot; the new native generation must already have been
   received and must exactly match a fresh, **upstream-verified** Content
   proof for that replacement Media Epoch. On acceptance, the fresh
   MicTrack enters the canonical Mic frontier, output edge, limiter and
   join-fade path. Authorization still does not invent missing PCM.

Every server event seals due frames **before** changing these decisions;
old transport and old media epoch messages cannot retroactively alter an
already-committed frame. Real PCM tests exercise 60 ms of disagreement,
deferred old tail, replacement sample authority and independent B output.
The singer evidence includes `reacquisitionPending` for an unchanged
active fallback and `requiresFreshContent` for the replacement's muted
calibration gate.

**Deliberate tradeoff:** this is safe *interrupted* reacquisition, not
phase-continuous in-place correction. It favors no wrong-verse jump over
seamless voice during large Content disagreement. The new Content measurement
has to come from the **new** capture; relabeling an old candidate with a
new epoch would defeat the purpose.

**Critical outstanding integration:** none of these experimental
`acceptTrusted*` APIs establish cryptographic or acoustic proof by
themselves. Their argument objects are not safe client-facing APIs. The real
server must derive transport identity, capture generation, proof revision,
media-epoch binding, accepted source, Take freeze and evidence age from a
private authoritative verifier. An authenticated user merely supplying a
new `proofRevision` is **not** enough. No production adapter, UI, live two-phone
test or automatic primary-Mic succession is introduced here.

## Server-owned six-second canonical Content proof (offline experiment)

The new opt-in proof path is `analyzeTrustedCanonicalContent(transportId,
mediaEpoch, startSample, nowMs)` followed by
`commitTrustedCanonicalContent(transportId, mediaEpoch, nowMs, takeFrozen)`.
It exists solely on `ChoirDeadlineRoomExperiment`; it is **not** exposed by
WebSocket, WebTransport, `server.ts` or the client.

Unlike older `acceptTrusted*` fixtures, this new path does not accept a
client-supplied lag, revision number, confidence, source label, Content
candidate or arbitrary PCM array. The room uses the currently authenticated
publisher's `MicTrack.timeline` plus the trusted Robot backing timeline,
both already reconstructed at the canonical room sample rate. It requires:

- A room configured with a valid, fixed 11-character `videoId`, a fixed
  song epoch and backing generation. The caller must still be the active
  transport for the server-owned Media Epoch.
- Exactly six seconds of **real positioned PCM** at a caller-selected room
  start sample, all present on both timelines. The six-second window must end
  within one second of the current trusted room clock (an experimental bound).
  Any gap, concealed source, absent future sample, unheadered chunk, outdated
  Robot generation, unknown native Capture generation, **PCM predating the
  current Mic or Robot capture origin**, or a window already evicted by
  retention causes an explicit rejection, **not silence padding**.
- The original production `analyzeTimingCalibration()` algorithm must
  accept the measured six-second correlation, including its spectral,
  distinct-peak and cross-window consistency guards. Analysis runs on
  internally copied reconstructed PCM. The numeric result is kept PRIVATE
  in the coordinator and cannot be overwritten through returned diagnostics.
- The commit must match the same authenticated transport, participant,
  Media Epoch, room/song/backing generations, fixed video ID and native
  Capture generation/source rate. The commit also requires the original
  six-second PCM window end to remain within one second of the trusted room
  clock; the absolute 20-second pending-expiry is only an additional ceiling.
  Disconnection, a newer candidate or an accepted new Media Epoch retires
  the pending result. One accepted/rejected eligible commit consumes it
  exactly once. Frozen Take prevents the commit.
- The room *chooses* the only valid transition: first rebound Content,
  bounded live fallback-to-Content correction, large disagreement staging,
  or new-epoch Content reacquisition. It NEVER accepts a client selection
  of those modes or a replacement signed-lag parameter.

This directly connects **real** PCM correlation to the experimental
scheduler and PCM playback, but still has important non-production limits:
the test room normally retains only three seconds of PCM, so its opt-in
six-second proof path requires at least six seconds of retained media
(10 seconds in the regression fixture); the eventual service needs a
separate bounded six-second calibration collection buffer or a consciously
larger per-source retention budget. The trusted **Robot-to-YouTube media
mapping, seek/pause/video changes and fresh timing origin** also need a
real server authority adapter; a static constructor `videoId` is not proof
that two arbitrary audio streams are from the same live song epoch.
Furthermore, the older `acceptTrusted*` experimental methods remain
low-level stubs accepting prevalidated input and must not be exposed as
user-callable handlers. No deployed endpoint is changed.

The new tests feed six seconds of distinct multi-band, +120 ms ground-truth
music as actual positioned Mic/Robot packets, call the original analyzer,
verify a valid one-shot Content authorization, reject closed/old transports,
block Take-frozen commits, and reject a pending analysis after a native
capture-generation restart. This is NOT equivalent to two physical devices
or a complete production evidence adapter.

## Content-only PCM memory and trusted Robot playback epoch (2026-10-14)

The latest offline Choir experiment no longer needs to enlarge the mixer
`retentionMs` to obtain six seconds for Content analysis. When a fixed
trusted 11-character video ID is configured, the deadline coordinator
creates a separate `ChoirContentPcmBuffer` for each admitted singer and the
Robot backing. The default is 7,000 ms, independently configurable between
6,000 and 10,000 ms. This cache mirrors *only new chunks admitted by the
canonical Mic/Backing ingest*, copying at most its configured sample budget.
It trims on every append, including within oversized chunks, and rejects
a six-second query if its oldest samples were evicted.

The PCM metadata is preserved (positioned versus unheadered, genuine
capture versus synthetic gap concealment, capture generation and source
rate). Any hole, concealed fill, missing frontier, wrong generation, or
non-positioned source rejects the whole Content window. The cache resets
when the native capture generation/rate changes, when a new trusted Media
Epoch replaces the singer, or when the Robot playback mapping changes.
These rules prevent the source playback ring's older samples from being
silently assembled into a new calibration. At 48 kHz mono int16, three
7-second caches occupy at most 2,016,000 bytes of raw sample payload
plus object overhead, distinct from the mixer and decoder allocations.

**Playback retention is not calibration retention:** `retentionMs=3_000`
still configures the existing Mic read budget. It is not automatically a
hard memory budget for all pre-existing source timeline structures, which
need a separate full-service memory audit. The new Content-only cache,
by contrast, has a bounded sample count verified by regression tests.

The experimental server-boundary requires an explicit
`setTrustedPlaybackMapping({ mappingEpoch, videoId, songEpoch,
backingGeneration, robotCaptureGeneration, playbackRate, playing }, nowMs)`
from its PRIVATE Robot controller before allowing any Content analysis.
This is not a client RPC. The first mapping must match the fixed room
song/video/Robot identity and be actively playing. A repeated or older
mapping epoch cannot promote new authority.

When the server observes a pause, seek, playback-rate/timeline revision,
video replacement or Robot capture-clock rebuild, the safe experimental
policy is to **fail the whole room closed** with
`resync-required: playback-mapping-changed`, clear undelivered PCM and
pending calibration, and require a genuinely fresh room/media mapping.
An unexpected backing generation or native source-rate change does the
same. This is intentionally stricter than an eventual user-facing
pause/resume implementation; it prevents the old Content lag or recorded
song-time map from surviving as a seemingly valid singing position. It
does not automatically promote the secondary Mic.

The Content analyzer's pending private proof includes the trusted
`mappingEpoch` and is consumed only while that mapping remains active.
The newer tests verify six-second analysis while the mixer is configured
with 3,000 ms retention, the 7-second hard Content-cache sample limit,
source/gap/generation rejection, Robot pause and seek hard latching,
and source generation/sample-rate replacement.

**Still missing for production:** the real Robot/YouTube controller must
provide a verified media timeline with explicit seek, pause and rate
transitions, room restart coordination, clock-mapping accuracy, and
authorized participant handshakes. Merely passing fields to a
`setTrustedPlaybackMapping`-named experimental API is not a secure
source of authenticity. Do not wire these methods straight to client
WebSocket or WebTransport messages. This change also does not build an
automatic primary-Mic succession or physical two-phone runtime.

## Server-authoritative SongSession bridge (offline-only)

A dedicated `ChoirSongSessionBridgeExperiment` now reads the actual
`SongSession.statusPayload(nowMs)` object, **after SongSession has accepted a
playback publisher**, AND the real `SourceRuntime` backing-control
`connected()` and `generation`. It does not read raw WebSocket song
telemetry, accept a client-submitted revision, or mint playback leadership.
The bridge refuses initial authorization if the Robot source has not yet
connected. After admission, `SourceRuntime.invalidateMapping()`, source
replacement, source disconnection or transport liveness loss immediately
revokes the offline room even when SongSession is still visibly PLAYING. On first valid playing
status it initializes the fixed Choir mapping using SongSession's server-owned
revision and leader identity. Subsequent stable clock projections do nothing:
the adapter does **not** invalidate a room every 20 ms or on every telemetry
heartbeat.

For a bridge status to initialize, the SongSession must report a fresh,
connected PLAYING leader, no active handoff, valid 11-character expected
video, a finite plausible playback rate, a non-negative server revision,
a consistent playback participant/transport/generation, and a finite
projected media position. The leader's accepted transport ID and page
generation are independently tracked. Ordinary rejected or hostile
telemetry never becomes Choir clock authority because it cannot update the
server-owned SongSession.

Once initialized, ANY accepted SongSession semantic revision, pause,
seek, rate/video change, leader transport/page generation change, active
handoff, loss of leader freshness, or projected-time jump of over 400 ms
causes an irreversible experimental `playback-mapping-changed` latch.
The cancelled room drops queued output without rendering stale catch-up
frames and discards pending Content. SongSession remains unmodified.
A fresh room epoch is required for any restart; this does not automatically
promote the secondary singer or silently relabel the old Mic.

**Important distinct generations:** the playback tab's
`SongSession.playbackGeneration` identifies its authenticated YouTube
page incarnation; Robot's canonical `backingGeneration` identifies the
backing PCM capture origin. They are *not* interchangeable integers.
The bridge tracks the former and passes the room's server-fixed latter to
the Robot PCM provenance guard. The test deliberately uses playback page
generation 1 and backing capture generation 9.

### Future integration points (not wired to production)

The current production server already owns `youtubeTimeline: SongSession`
in `src/server.ts`. Its authenticated telemetry gate precedes
`youtubeTimeline.update(...)`, and only an accepted result enters
`youtubeTelemetryAccepted`. A production Choir adapter should observe
the SongSession **after that accepted update**, after playback
`detach(...)`, and at a bounded periodic freshness check independent of
incoming packets. The authenticated Robot transport path is separate:
`robotSourceActivated`, `robotSourceClosed`, and the backing capture
restart path must supply backing-generation continuity and invalidate
the new Choir epoch before old Content may be re-applied.

The offline bridge proves these control-plane contracts with real
SongSession instances and accepted telemetry. It **does not** connect a
live Choir endpoint, trust browser-reported acoustics as independent proof,
take over the existing production Mic, or change the N=1 AudioSession.
Actual server wiring needs the trusted Robot source clock and the backing
PCM ingest boundary plus a room restart handshake. In particular, a
fresh SongSession timeline proves admission/clock control, not by itself
that a physical singer heard the correct YouTube position.

## Default-off server shadow boundary and explicit restart epoch (2026-10-14)

PR #576 now introduces `RELAY_CHOIR_SHADOW` as an **explicitly disabled by
default** server setting, validated by `loadRelayConfig`. Even with this
flag enabled, this is **only a control-plane observer**, not a Choir server
transport, media mixer, recorder, monitor, speaker output, microphone
publisher or UI. Its implementation deliberately does not receive Mic or
Robot PCM packets and cannot admit any Choir singer.

When enabled, `startRelayServer()` privately owns a
`ChoirShadowLifecycleExperiment` reading its existing
`youtubeTimeline: SongSession`, `sourceRuntime: SourceRuntime`, and the
actual session's Robot backing PCM generation. Its observation hooks run
after accepted SongSession telemetry, on playback detach, Robot source
attach/close, backing PCM capture restart and from the existing 250 ms
timeline timer. No new always-running timer, public socket type or
new client command is introduced. With the flag disabled, these hooks
immediately no-op.

On a new verified playing song and active Robot with a real backing
generation, the observer creates a fresh private shadow room with a
server-monotonic room/song epoch. A stable YouTube projection does not
recreate the room. Loss of playback authority, seek/pause/rate/video
revision, Robot identity replacement, clock jump or PCM backing-generation
change irreversibly retires the room. The old instance and proof caches
cannot be recovered by a later PLAYING heartbeat. A new room needs a
strictly newer room epoch and song epoch explicitly approved through a
private `authorizeExplicitFreshRoom(retiredRoomEpoch, proposedRoomEpoch,
proposedSongEpoch)` method, which is **not called by production**.

**Important boundary:** this is an offline restart gate proving epoch
fencing. It is not yet a two-singer resume handshake, and authenticating
a user before admitting a new Mic capture is still a separate
production prerequisite. The shadow's verification is useful for detecting
where production events occur and confirming that stale SongSession
and Robot SourceRuntime generations cannot be silently recycled. Do not
configure the feature on a production deployment expecting functional
Choir audio: there is no such route yet. The entire single-Mic AudioSession
remains the production signal path.

## Experimental fresh-room A/B rejoin handshake (2026-10-14)

The new `ChoirFreshRoomHandshakeExperiment` represents an explicit private
fresh-room restart agreement **separate** from the existing default-off
server `ChoirShadowLifecycleExperiment`. No production client transport,
public endpoint, UI or Take/mixer/monitor/record output routes invoke this
handshake yet. The future server integration must supply authenticated
participant and transport identities, verified SongSession and Robot
control-plane epochs, and an *explicit* restart decision; receiving an
ordinary PLAYING heartbeat must never call `beginTrustedRoom`.

In each new room:

1. A verified trusted host fixes `roomEpoch`, `songEpoch`, video, Robot
   backing generation, and the EXACT expected primary and secondary
   participant IDs. Room and song epochs must strictly increase after every
   retirement. No previously connected singer is silently admitted.
2. The primary must rejoin through `admitVerifiedSinger` first, followed by
   the secondary with an independent trusted transport. The secondary cannot
   claim or automatically inherit primary status.
3. Every admission receives a globally increasing server-issued
   `mediaEpoch`, continued from the previous room's unissued frontier.
   Old room tickets (including otherwise-correct transports/Media Epochs)
   cannot ingest PCM, submit Content analysis or authorize audio in a new
   room. An admission cannot alias another participant's transport.
4. **Strict first-capture authorization:** the fresh-room option
   `requireInitialContent=true` is forced by the handshake, so even the
   very FIRST MicTrack for both A and B starts with `awaitingCalibration`
   and `requiresFreshContent`. This fixes a regression uncovered by the
   real 6-second A/B test: initial room admission previously allowed audible
   Mic without proof. Older standalone Choir scenarios preserve their
   original defaults, but not the secure restart handshake.
5. Six seconds of fresh native-generation positioned Mic AND Robot PCM
   must pass the original Content correlation algorithm for **each singer
   independently**. The private coordinator alone consumes the retained
   candidate exactly once, checks current transport, room/song/Media Epoch,
   capture/source generation and playback mapping, and rejects Take freezes.
   A valid A proof cannot unmute B, nor vice versa. No historical
   Sample/Boot/Content decision carries across a room restart.
6. Both singers retain independent PCM output edges, limiters and gains.
   The test-only `advanceDue` drops all mixed PCM output instead of
   routing it to listeners; `lastSingerEvidence` exposes only the numeric
   mute/voice-peak diagnostics for proof that uncalibrated captures stay
   silent and that independently validated new captures become audible.

Disconnecting A does not promote or release B. A disconnected ticket is
not reusable; the existing explicit capture-rebind/fade contracts govern any
future same-room reconnect extension. Retiring a room erases all tickets,
calibrated singer IDs, output diagnostics and buffered audio sources. Creating
a new room requires higher Room/Song Epochs, without auto-resumption.

**Remaining integration:** the default-off server shadow still only OBSERVES
SongSession/SourceRuntime. It deliberately has no API that trusts client
`beginTrustedRoom` or connects this handshake to actual sockets. A real
two-singer media path, 2-device physical test, room-restart handshake and
authorization of the remote user's explicit Mic Take are separate follow-ups.

## Room Restart Coordinator: explicit trusted CAS + A/B status previews (2026-10-14)

`ChoirRoomRestartCoordinatorExperiment` is the *offline* bridge between the
previously independent `ChoirShadowLifecycleExperiment` (watches authoritative
`SongSession` and `SourceRuntime`) and
`ChoirFreshRoomHandshakeExperiment` (new A/B capture admission and acoustic
proof). The server now constructs it under the existing **default-off**
`RELAY_CHOIR_SHADOW` flag, in place of directly observing the shadow.
Crucially, the actual `server.ts` constructor injects an authorization
policy that ALWAYS RETURNS FALSE and Take-clearance that ALWAYS FAILS
CLOSED. No production client can approve a restart, join a singer through
this route, route PCM, or request new monitoring/recording output.

The isolated approval contract is `approveTrustedRestart()`, but it must
be called by a future private server coordinator, *never* by a new generic
WebSocket/HTTP handler. It compares the caller's expected last-approved
Room Epoch and expected server SongSession revision, checks a fresh playing
SongSession leader and live Robot control/capture generations, refuses Take
freeze, and delegates role approval to a separately injected
**server-owned authorization callback**. In particular, an actor name
or client-supplied primary/secondary names are not authentication. Even a
correctly formatted request with a stale revision, missing actual Robot
source or unauthorized actor cannot create or reuse a room.

With a valid *explicit* approval, Shadow's new Room/Song Epoch is matched
to the private fresh-handshake's Room/Song Epoch and fixed A/B identities.
After Seek, SourceRuntime replacement, clock discontinuity or stale leader,
`observe()` retires all previously issued A/B tickets; a renewed PLAYING
heartbeat by itself does not authorize another room. After fresh private
approval, separate A and B joins issue their own strictly increasing Media
Epochs and require **independent newly measured Content evidence**.

The offline private methods for new PCM, Robot backing, Content analysis and
Content application recheck live `SongSession` and `SourceRuntime`
authority *on every call*, not just in a periodic observer. A Seek racing
between timer ticks therefore rejects the previous ticket immediately.
Take freeze is checked again at the instant of Content application.
No application can use a retired ticket or a prior song's acoustic proof.

The read-only `previewForVerifiedSinger` and `preview` methods define
the next possible UI *contract*; they do NOT send client notifications or
release tickets, transport identifiers, capability keys, PCM or analyzer
arrays. A future authenticated server handler might show:

- Room invalid or not approved: "重新建立房間中"; no singer authority.
- Approved, A not rejoined: "等待主 Mic 重新加入".
- A joined and B not joined: "等待副 Mic 重新加入".
- Joined but not calibrated: the singer shows "等待 Content 校準".
- Only one Content verified: that singer is **eligible** to play, the
  other remains gated.
- Both verified: both are **eligible**, subject to separate actual PCM
  frontier/audio-health checks.

The `monitoring` field is only a diagnostic **planned mix eligibility**
label (`unavailable`, `backing-only`, `one-voice`, `two-voices`), not
a claim that real speakers are receiving sound. Until the production media
path is integrated, there is no Choir monitor/record stream and no physical
participant notification. This remains distinct from the deployed N=1
audio pipeline and preserves the decision to omit automatic primary-Mic
succession in v1.

Regression coverage uses real `SongSession`, `SourceRuntime` and PCM
Content evidence to check initial authorization denial, valid explicit
CAS, operator rejection, frozen Take, stale revisions, emergency Seek
without a clock-tick callback, fresh Room/Song/Media Epochs, A/B role
isolation, and independent Content readiness. Do not confuse this with
an end-to-end mobile/desktop Choir deployment test.

## Secondary-only PCM ingress adapter and server quarantine (2026-10-14)

`ChoirSecondaryPcmIngressExperiment` is a deliberately PRIVATE transport
bridge for the already-authenticated secondary singer. It is instantiated
only when `RELAY_CHOIR_SHADOW=1` and is called ahead of production
`audioUplinkReceived`'s normal primary Mic/Robot switch. It consumes
binary packets ONLY from a socket that the server has explicitly attached
through `bindVerifiedSecondary(socket, ticket, sourceRate, nowMs)`. The
production server **never calls that bind method**: its injected room
approval and Take clearance are still unconditionally false. No new
client-facing registration command, secondary-microphone UI, WebTransport
path, recorder or monitor output is enabled.

The private bind path requires a native authenticated
`socket.participantId` matching the SERVER-issued ticket, a fresh
`roomEpoch/songEpoch/mediaEpoch`, specifically the **secondary** seat,
unclaimed `unknown` socket role (not an existing production
publisher/backing/monitor), valid native sample rate, a live socket and
`coordinator.mayAcceptVerifiedTicket` confirming the ticket is actually
active in the current room. The ticket is stored in a WeakMap keyed by the
exact physical socket, with a separate single-claim transport registry:
**one live ticket cannot be bound by two physical sockets at once**.
A periodic stale-binding sweep releases old strong references after room
revocation, while the old physical socket remains quarantined by its
WeakMap entry until close. No sender-supplied participant ID, room ID, seat
or lag is parsed from PCM or trusted. Closed sockets revoke only that
singer and cannot accidentally promote a replacement primary.

Binary frames must carry Relay's existing 16-byte `RL` v1 header with
zero reserved flags, the native capture generation, integer non-negative
sample cursor and complete non-empty little-endian int16 mono PCM. Frames
over 200 ms, over the conservative 192kHz byte ceiling, or over 150
packets/s per attached socket are rejected. After one native generation
is accepted, a changed generation is rejected pending an explicit new
Media Epoch rather than silently aligning two unrelated captures.
No unheadered/legacy PCM is accepted by this N=2 ingress. Every frame
then revalidates SongSession, Robot authority, exact current ticket and
media epoch THROUGH the existing private Room Restart Coordinator.

Importantly, once attached, a malformed, revoked or out-of-order
secondary frame is still **intercepted**. It cannot fall through to the
production N=1 Mic/Robot intake. The server also ignores JSON control
commands on this attached socket to prevent a secondary singer from
seizing the deployed primary Mic or controlling Robot/song playback via
the same socket. An unattached socket follows the original production
logic unmodified. The adapter does not copy any Choir PCM into production
audio, monitor or Take recording.

Test coverage includes authorization and role fences, RL framing and
sample cursor validation, malformed, unpositioned and oversized frames,
capture generation changes, per-socket ingress limits, socket identity
changes, close, stale room and Seek between timer ticks. An integration
test uses the REAL SongSession/SourceRuntime/Room Restart Coordinator
with a secondary authenticated socket, then confirms the same old packet
is intercepted but rejected after a Seek. This is a **transport skeleton**,
not a functioning client-side second Mic feature; its attach entrypoint is
unwired until real server role/Take authorization and fresh room approval
are implemented and audited.

## Phone AudioPacket v2 on secondary-only ingress (2026-10-14)

The isolated secondary transport now understands BOTH Relay's original
16-byte `RL` v1 positioned-PCM packet and the actual phone/media-plane
24-byte `AudioPacket v2` container. **The server chooses exactly one
packetVersion (1 or 2) when privately binding a verified B ticket**.
Incoming packets are never auto-detected or silently downgraded, even
though both formats begin with `RL`. A bound v2 socket rejects v1,
Opus v3, backing-source packets, malformed count/payload pairs, corrupt
sample cursors and wrong capture generations. An old v1 socket rejects
v2 rather than misreading its sequence metadata as audio samples.

For v2 the original `decodeAudioPacket` implementation provides the
source, generation, sequence, PCM length and source-native sample cursor.
A per-socket bounded sequence window retains at most ~129 recent
sequence/sample spans (newest plus 128 behind), allows ordinary reordering
and uint32 wraparound, rejects already-seen packet IDs and overlapping
PCM positions, and limits forward jumps to four reorder horizons.
Retries are *not* replayed into the canonical MicTrack; rejected
duplicates do not advance the accepted sequence or capture generation.
This is an **experimental bounded anti-replay policy**, not yet the full
v2 production retransmit scheduler. It deliberately fails closed on very
long outages: a new, explicitly admitted Media Epoch is required rather
than assuming a stale capture still shares the room clock.

All existing hard gates still apply: matched live authenticated B socket,
valid room/song/Media Epoch, one physical socket per ticket, 200 ms
maximum packet duration, 150 frames/s, current SongSession and Robot
control authority, fresh Content before first audible Mic, and no
access to deployed N=1 output/monitor/record. The v2 module has no Opus
decoder; accepting audio packet version 3 as PCM would have been unsafe.

Tests cover v1/v2 downgrade refusal, backing/Opus packet rejection,
malformed metadata, v2 duplicate retransmission and sample overlap,
bounded out-of-order delivery, uint32 sequence rollover and out-of-window
replay. An integration case instantiates real SongSession/SourceRuntime
and the Room Restart Coordinator, delivers a true phone-style v2
secondary packet, confirms B stays awaiting calibration and then
confirms a SongSession Seek rejects the very next packet. A real
browser/phone secondary publishing session and role-grant UI remain
unimplemented. The default-off production Shadow does not grant
secondary tickets or route any Choir audio.

## First-version Mic owner, B consent and Take gates (2026-10-14)

A private experimental role policy now explicitly distinguishes Relay's
**current live Mic owner** from the **YouTube playback leader**. The latter
is a clock authority and may be another person; it cannot approve another
participant's microphone. An eligible room grant requires all of:

- The authenticated request actor is the current Relay primary Mic owner.
- The existing `ParticipantSession.micOwnerId` and the live
  `MicRuntime.mediaOwnerId` agree with that primary; its control socket
  remains connected and the primary participant has a live presence.
- The named secondary is a distinct, connected Relay participant who has
  **explicitly consented to this exact upcoming Room Epoch** through a
  future separately authenticated server consent channel. Mere presence
  and a nickname are not proof of consent.
- The Take lifecycle is not `recording` or `finalizing`.
- All existing SongSession, Robot, Room/Song/Media Epoch and verified PCM
  protections remain in force independently.

`authorizeChoirRestartWithLiveRoles` implements and tests the above as
a SERVER-ONLY policy. No live client consent handshake exists yet.
Production's existing Shadow coordinator still injects an unconditional
**deny** for new grants, and a deny-by-default ongoing role check;
this new policy is not silently promoted into public room authority.

Once a room is approved in the offline fixture, **ongoing** Mic owner,
B consent and Take authority are rechecked on each control/media
operation. The role continuation predicate includes the *exact current
Room Epoch*. If any permission changes or Take starts, the Shadow room is
now irrevocably retired as `restart-required`, not simply hidden behind
an ambiguous `awaiting-authority` state. Recovery requires a new explicit
restart CAS with fresh A/B Media Epochs and individual Content proofs.
Tests confirm neither ending Take nor restoring consent can revive old
tickets automatically.

Next missing production piece: an authenticated, explicit secondary
opt-in/opt-out control-plane workflow that is revocable before and during
each Room Epoch, with proper per-participant consent and host display.
Until then the server remains deny-by-default and a second phone cannot
join Choir using any current client command.

## Explicit B opt-in control plane (2026-10-14)

A new `ChoirSecondaryConsentExperiment` now implements an actual
**default-off** server WebSocket invitation/consent exchange under
`RELAY_CHOIR_SHADOW=1`. The new authenticated messages are:

- `choir-secondary-invite` from the live primary-Mic owner's **separately
  authenticated** control socket, with a target `secondaryId` that must
  already be a connected participant.
- `choir-secondary-invitation` delivered ONLY to sockets authenticated as
  that secondary participant, with a random non-authoritative invitation ID,
  proposed Room Epoch, video identity and short expiry.
- `choir-secondary-accept` / `choir-secondary-decline` from B's own
  authenticated socket referencing that invitation ID.
- `choir-secondary-withdraw` from the *same physical B socket that consented*
  to revoke the accepted grant. The host receives a targeted status update.
  Forged or expired attempts receive `choir-consent-rejected`.

The server derives every participant identity from the existing private
browser capability; it never accepts a client-submitted primary seat, room
generation or capture ticket. Invitation IDs alone confer NO authority,
and an unrelated user possessing an invitation ID cannot accept it for B.
The host's Mic lease is rechecked against both `ParticipantSession.micOwnerId`
and `MicRuntime.mediaOwnerId`, live primary transport, B presence and
current non-recording Take status.

A pending invitation expires after 30 seconds. An **accepted** consent is
not subject to the pending-invitation timeout: it remains scoped to the
same (A, B, Room Epoch, SongSession revision/video, Robot backing/control
generation) until B explicitly withdraws, either consenting control socket
closes, the role changes, recording begins, or the playback source
changes. The bounded in-memory state has at most one invitation per host;
stale entries are swept by the existing server timer. Both A and B
may have multiple browser tabs, but a retry from an *unrelated physical B
socket* cannot replace the original accepted consent without a new invite.

The coordinator exposes a **read-only next Room Epoch proposal**. When a
Seek retires Room 1, the server can ask B to consent to proposed Room 2
*before* any explicit restart CAS creates Room 2. Neither the invitation
nor its proposal mints a Media Epoch. This resolves the potential deadlock
between "B must consent before approving the next room" and "the previous
Shadow room is already retired".

The live role-continuation predicate now refers to this consent model and
the existing `authorizeChoirRestartWithLiveRoles` policy. **Production
still passes an unconditional false restart-approval callback and
unconditional Take freeze to the Choir experimental coordinator**, so this
new protocol cannot create an active Choir room, attach a secondary PCM
socket, output Choir audio or change existing N=1 monitoring/recording.
The client UI has not yet been updated to show the invitation or accept/
decline controls; there is no released Choir mode.

The isolated contract tests verify explicit acceptance, decline and
withdrawal, capability-style socket identity matching, invitation expiry,
cross-room and cross-song revocation, disconnected B, primary-owner change,
Take freeze and physical-socket-specific consent. The real-server smoke
test authenticates two distinct browser-capability identities and verifies
that Choir commands cannot manufacture a room when authoritative Robot/
Mic prerequisites are absent. These prove the control boundary; they
are not yet a full two-device, permission-granted Choir media session.

## Default-off Choir invitation UI on the actual Relay page (2026-10-14)

The Live page now includes a compact `+ Second Mic / + 副 Mic` action beside
the normal Take/Release Mic controls. This control is **hidden by default**,
including during ordinary N=1 relay operation. Only when an already
authenticated Presence socket receives the private
`choir-consent-available { mode: 'invitation-only' }` server event under
`RELAY_CHOIR_SHADOW=1` may it become visible; the client also requires an
authoritative session snapshot, local primary Mic ownership, an active
connected Mic, and at least one distinct online participant.

`public/choir-consent-ui.js` provides a small phone-width accessible panel
to choose B, request the invitation, show the host's reply status, and let B
accept/decline/withdraw through its authenticated Presence socket. B's
incoming invitation is displayed even when B does **not** own the primary
Mic. A server invitation is not an actual Mic authorization, and UI text
states explicitly that no second-Mic capture starts upon acceptance.
English and Traditional Chinese strings are shipped together.

The existing Presence socket is the ONLY page-side command path. It relays
four known consent opcodes, uses the identity already established by
`participant-authenticate`, and clears UI authorization when the socket
disconnects or the server no longer advertises the feature. Incoming
nicknames are inserted as `textContent`, not HTML; the page does not send
browser capability secrets as a Choir payload. No secondary Media Epoch,
capture permission, producer registration or monitor/record URL is exposed.

A server ACK for B's withdrawal now includes `secondaryId` so the client
can distinguish its own withdrawn consent and hide its Withdraw control.
A separate Chromium phone-DOM test checks the default-hidden state,
host participant picker/command, B accept/withdraw command and
disconnect-driven hiding, including horizontal-overflow checks. A
server-side UI contract test also checks that the production HTML retains
the hidden default and does not couple this module to `getUserMedia`.

**Not enabled:** production Choir admission, an actual second-phone Mic
publisher, verified Content calibration in the real runtime, and N=2
monitor/record. Server restart authorization remains an unconditional
deny. These UI additions are an intentionally isolated invitation
experience and must not be described as a deployed duet.

### Verified authenticated invite integration (positive path)

The server smoke now also establishes real browser-capability identities for
A and B, a distinct authenticated A publisher with a valid primary Mic lease,
a registered Robot backing source, a live Robot control socket, and a genuine
positioned PCM backing frame that establishes the native backing capture
generation. It then drives the existing SongSession through accepted Load
and Play command/telemetry handshakes, and asserts that A's invite reaches B,
B's acceptance returns to both control sockets, and B's withdrawal revokes
the opt-in. **No secondary-registered or new audio route** is ever created.
This is a real WebSocket control-path proof, rather than simulating
authentication or calling Choir classes alone.

One earlier positive smoke correctly failed until the Robot sent its first
PCM: a registered Robot *control* source without any PCM has no trusted
`backingGeneration`. We fixed the test to provide real positioned backing
audio rather than permitting a missing-generation Choir room. The temporary
server diagnostic output used to identify this test fixture problem has
been removed.

## Exact-control-socket B Media Epoch claim (2026-10-14)

`ChoirSecondaryMediaTicketExperiment` is now the private bridge between an
already-approved canonical A/B room, **B's actual consent-bearing authenticated
browser Socket**, and a separately authenticated B audio Socket. It is
constructed in default-off Shadow server mode but has **NO public issue or
redeem WebSocket handlers**. The production Choir restart authorizer is
still hard-deny. This is an experimental, tested ticket *backend*, not a
second live Mic feature.

The issuance protocol deliberately has two phases:

1. After a trusted server CAS has created a room and A is *already*
   admitted as primary, `issue(consentSocket, nowMs)` checks that its
   physical browser socket actually accepted B's room-specific invitation,
   the original A/B Room Epoch is still valid, and the Take/role/song
   mapping remain valid. It returns a cryptographically random 256-bit
   token with a 15-second expiry. The claim is not itself a Media Epoch,
   producer role or permission to capture; issuing it does not reserve a
   singer seat. At most one pending claim exists per B.
2. `redeem(mediaSocket, claimToken, rate, packetVersion, nowMs)` demands a
   *different* live authenticated B Socket with `role='unknown'`, the
   same exact live A/B room and consent, supported native PCM sample rate
   and v1/v2 framing. The token is burned before side effects, including
   on a mismatched B identity. Only after all proof checks pass does the
   coordinator mint B's strictly increasing Media Epoch and a
   server-generated transport ID, then bind the exact socket to the
   secondary-only PCM ingress. Old token replay or a second claiming
   socket cannot mint another ticket. PCM remains muted until **B's fresh
   canonical Content proof**. No automatic primary takeover occurs.

An important physical-bind recovery problem was exposed by an additional
integration test: the existing first-version canonical Choir session does
**not** support arbitrary same-room rebind of B after an admitted seat
disconnects, even when no authorized B PCM was audible. Therefore if
canonical admission succeeds but the transport bind fails, the coordinator
now **retires the ENTIRE experimental Room Epoch** and requires a new
trusted restart CAS, explicit fresh B consent and new Media Epochs. It
does *not* claim that merely deleting the B ticket allows a same-room retry.
This is deliberately conservative and cannot change the deployed N=1
Mic/monitor/record paths.

Contract tests use real SongSession/Robot/Choir coordinator, B consent,
two distinct B socket identities and the v2 binary PCM ingress. They
cover a stolen single-use token, sibling B browser tab, repeated token,
token expiry, superseding issuance, consent withdrawal, Seek, B's
pre-Content mute and bind-failure room retirement. The next distinct task
is the server-authorized public media-claim exchange and fresh capture
registration/Content analysis, **not** silently enabling those paths from
an accepted invitation.

## Double-gated server media handshake and browser opt-in (2026-10-14)

There are now TWO independent server flags, both default OFF:

- `RELAY_CHOIR_SHADOW=1`: authenticated invitation/consent control plane
  and room authority observation ONLY. No client may start a Choir room,
  redeem a Media Epoch or send secondary PCM.
- `RELAY_CHOIR_MEDIA_EXPERIMENT=1` **in addition** to the Shadow flag:
  enables deliberately isolated A/B room restart and a private two-step
  B media registration protocol, with NO connection to production N=1
  output, monitor, Take recording, or automatic primary succession.
  Setting the media flag alone has no effect.

In double-opt-in mode the existing authoritative live Mic/participant/Robot/
SongSession + non-active Take policy is used for both the explicit room CAS
and the ongoing permission check. The host must be the actual current
Mic owner with a live, verified production N=1 publisher connection.
Only after B has separately consented to the proposed Room Epoch may host
send `choir-room-begin { secondaryId }`. The server, NOT the client,
derives the exact expected Room Epoch and SongSession revision. It grants
a **muted, logical primary seat** for A (A's production N=1 Mic PCM is
NOT copied into this experiment yet) and returns `choir-room-ready`
only if the room CAS and first admission succeed. If primary admission
fails, the server retires the whole experimental room.

The original B consent Socket may then send
`choir-secondary-media-claim-request`, receiving a short-lived
`choir-secondary-media-claim` with a random one-use 256-bit token.
The browser creates a DISTINCT uncompressed `/ws` media connection,
sends its usual `participant-authenticate` message on that connection,
and only after receiving an identity-matching
`participant-authenticated` reply submits
`choir-secondary-media-register { claimToken, packetVersion: 2,
sampleRate: 48000 }`. Claim identities and room/seat/Media Epoch supplied
by the browser are NEVER used as authority. On success, the exact media
Socket is quarantined as Choir secondary and receives
`choir-secondary-media-registered` with server-owned increasing
`mediaEpoch` and `awaitingContent: true`. It can feed strictly validated
mic-only AudioPacket v2 into the experimental canonical room; it cannot
register as the production primary publisher, Robot backing or monitor.

The invitation UI shows separate "Create experimental room" (A) and
"Connect second-Mic test" (B) actions ONLY when both flags are on, and
closes B's separate media connection after consent withdrawal/revocation
or Presence loss. Claims live only in the browser's event-local memory;
they are not placed into URLs, persisted or logged.

**Critical scope limit:** the browser-side new media connector deliberately
does NOT request `getUserMedia` or start automatic audio capture. The
integration test, however, sends *real binary AudioPacket v2 PCM* through
the same independently authenticated media registration on a live test
server, verifies B remains pending Content calibration, confirms that
failed production publisher registration on that socket is ignored, and
checks withdrawal/Seek rejection. This proves the **wire-level join and
isolation**, NOT yet actual phone mic clocks, A's Choir voice, a complete
trusted six-second Content comparison on production sockets, or any
audible duet. All production N=1 monitoring and recording behavior must
remain unchanged.

The first-version canonical seat is non-rebindable after physical
disconnect. B disconnect therefore retires the experimental room
(instead of silently allowing a same-epoch replacement); any restart
requires a new explicit CAS, fresh room-specific B consent and new
Media Epoch. None of these rules imply automatic primary Mic takeover.

## B mobile native-clock PCM uplink (2026-10-14)

The separate, explicit B "Connect second-Mic test" tap now initiates its
own `getUserMedia` permission prompt, new AudioContext, and Relay's
existing `capture-worklet.js`. No ordinary invitation, accepted consent,
login, server push, or successful Media Epoch registration starts capture.

The capture uses the same unprocessed mono microphone constraints as the
production Mic; applies `enforceUnprocessedCapture`; uses the running
AudioContext's ACTUAL `sampleRate` (44.1 kHz, 48 kHz and other supported
native rates are not silently relabeled as 48 kHz); and creates an
independent random uint32 native capture generation and monotonically
increasing sample cursor. The captured Worklet's 20 ms Int16 PCM chunks
are framed exactly as `AudioPacket v2`: mic source, actual generation,
uint32 packet sequence, actual sample count and native firstSampleIndex.
The module reuses the existing Worklet graph lifecycle, including zero-
gain output to the local playback, and does NOT request production Mic
ownership or start the primary publisher.

The B tap **prepares capture before requesting the 15-second server media
claim**, so the short-lived claim is never left expiring while the browser
asks permission or discovers a real hardware sample rate. Once that
capture is ready, the verified Presence socket requests a claim; the
already-separated B media Socket authenticates and registers with that
actual rate. Only after the server confirms its server-owned Media Epoch
does the browser send real PCM. A missing, wrong or revoked grant never
transmits PCM as the primary Mic.

The page advances its native cursor for EVERY Worklet PCM chunk, including
chunks dropped during network backlog, stale main-thread dispatch or
disconnection. Therefore rejected delivery leaves an explicit native-
sample gap instead of compressing the music timeline. It discards PCM
older than 200 ms and bounds WebSocket bufferedAmount to 256 KiB; no
retained PCM is replayed after a reconnect. Capture input-gap, processor
failure, device route replacement, local track mute/end, or AudioContext
suspension/closure fail closed by disposing the graph, stopping tracks and
closing the separate media socket. Changing Room Epoch or withdrawing
consent requires a new deliberate user action and NEW Media Epoch.
The worklet's recycled PCM buffer is returned only after packet bytes
have been copied.

A new parity test decodes browser-framed packets with the REAL server
`decodeAudioPacket`, including 44.1k (882-sample) and 48k (960-sample)
20 ms chunks, and asserts generation/sequence/sample-index integrity.
Additional tests cover invalid native cursors, backlog gaps, stale PCM,
buffer recycling, synthetic input-gap retirement and old-epoch callbacks.
UI checks ensure the physical tap precedes the claim request.

**Audio proof limitation:** This confirms native B Worklet PCM transport,
NOT valid cross-device song alignment. The real server still does not
copy the A production Mic or Robot PCM into the Choir proof-specific
canonical room, nor expose the trusted six-second Content solver as a
production authority. B remains muted within the isolated Choir room,
and N=2 monitor/record output is intentionally absent. Two physical
phones have NOT yet been measured or verified for live Content phase
agreement; production N=1 is unchanged.

### Capture-clock stall protection

Native PCM cursor continuity alone cannot detect an AudioContext whose
rendering speed falls behind reality. The secondary collector now compares
native captured sample count against `performance.now()` over rolling
five-second windows. A clock-speed ratio outside 0.75–1.25 permanently
stops that B capture; the old Media Epoch and PCM cannot be resumed on
the same socket. This explicitly guards the previously seen 66%-speed
AudioContext failure pattern. Actual Worklet sample timestamps are also
checked against the current AudioContext clock for up-to-200ms age before
sending; the secondary WebSocket queue is further capped at 24 KiB, not
256 KiB. Both clock checks are lightweight constant-time operations per
20ms PCM chunk, never an FFT or Content analysis on the audio thread.

These are conservative *admission* fences, not time-alignment solvers.
Real-world two-device Content and drift measurements are still required
before any singer can be made audible. A slow or interrupted capture is
aborted rather than guessed forward.

## Trusted A + Robot production PCM mirror (2026-10-14)

The experimental N=2 room now has a **source-owned PCM bridge** instead of
waiting for clients to claim that two audio streams belong to the same song.
`ChoirTrustedSourceMirrorExperiment` binds at A's successful explicit room
start to all of these actual server-observed identities: current production
N=1 publisher socket, authenticated primary Mic owner, native v2 Mic capture
generation, Mic native sample rate, actual Robot backing transport socket,
Robot PCM capture generation/rate, and Robot control-source generation.

The bridge cannot mint a Media Epoch, read an arbitrary browser filename or
claim an unrelated song. Once bound, it is fed ONLY from:

- `processPublisherFrame()`, **after the existing N=1 ordered decoder and
  production Session have accepted a positioned primary Mic PCM frame**.
  Browser packets on B's transport, old publisher packets, unpositioned
  legacy Mic data, or invalid/rejected duplicates cannot become Choir A
  evidence. Native A and B rates need not be the same: each track retains
  its own source rate before canonical room resampling.
- `audioUplinkReceived()` on the existing Robot backing path, **after
  Session has accepted a true Robot PCM frame**. The source must still be
  the same trusted Robot backing socket, capture generation, rate and
  control generation that were fixed at explicit room admission.

Both actual source clocks are placed into the same isolated canonical room
time axis using its existing native-generation-aware MicTrack and
PcmTimeline mapping. Existing separate seven-second Content history buffers
accumulate those accepted positioned samples; the ordinary three-second
live mixer retention was **not** increased to six seconds. The existing
five-millisecond mixer timer may drain the experimental room's due frames
into numeric evidence only; none of its PCM, effects or monitor output are
sent to N=1 clients or Take recording.

The bridge rechecks source ownership before every frame. Replacement of
A's publisher socket, Mic capture generation, Robot PCM source/socket or
Robot control generation retires the *entire experimental Room Epoch*
rather than combining old and new chunks or automatically making B the
primary. An A room cannot start without a true positioned v2 generation.
A real-six-second Content contract test feeds music-like Mic and Robot
PCM through this server-owned bridge alongside B's separately verified
Mic and proves both independent Content analyses can accept and commit,
while a separate test shows each source swap invalidates the room and
refuses subsequent old PCM.

**Not yet bridged:** invoking the expensive six-second Content analyzer
safely in a real asynchronous worker from the production Node server;
this test calls the analyzer explicitly in its isolated fixture. The
browser and server have a trusted data path, but **no live Choir microphone
has been unmuted and there is no N=2 output**. Content is not a mere
continuous PCM byte counter: the solver must reject incomplete, stale,
concealed or mismatched-mapping windows before using an inferred lag.
Actual dual-phone Content measurements and song-clock calibration remain
required before any of this is considered deployable.
