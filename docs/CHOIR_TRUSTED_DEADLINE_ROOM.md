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
