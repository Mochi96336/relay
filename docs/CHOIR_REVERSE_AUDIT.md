# Choir reverse audit — 2026-10-13 (Draft-only)

Scope: stacked Draft PRs #571, #573, #576. Reviewed at the #576 branch.
All new Choir policy/audio modules remain unreferenced by the live server.
**This is NOT a completed real-time choir and is not approved for merge.**

## Corrected in this audit

1. **Stale packets across song/backing epochs** — choir PCM packets now carry
   singer-scoped song and backing generations in addition to mic capture
   generation; the ring rejects cross-epoch packets. A server integration
   must populate those fields from verified session state, not the client.
2. **PCM memory/work bounds** — source rates are bounded (8-192 kHz),
   per-track ring allocation is capped, packets longer than two source
   seconds are rejected, and old samples cannot replace ring slots stamped
   with newer samples. This does not replace actual network packet limits.
3. **Expired reconnect grace** — an old primary lease is explicitly expired
   *before* attempting a new admission; it does not silently resume after
   grace or make a secondary primary. A new explicit Take Mic may claim it.
4. **Paused-song Seek** — a follower at the wrong position may Seek even
   while paused, subject to a cooldown, rather than starting the wrong verse.
5. **Content candidate promotion race** — each singer's pending analyzer
   result has a monotonic revision; a later attempt invalidates previous
   pending results without dropping separately confirmed Content.
   External rejection or successful promotion consumes the candidate.
6. **Boot stale baseline** — an accepted probe baseline expires after a
   conservative experimental five-minute age, even if Robot's current
   player delta is fresh. Phone/Robot output route changes still demand
   explicit invalidation; age alone cannot detect them.
7. **False-positive end-to-end tests** — added test with *independently
   placed source PCM transients*. The test no longer places its pulses from
   the very calibration value being validated, which previously made
   agreement nearly guaranteed regardless of algorithm correctness.

## Still blocking live release (P0)

- **No live protocol integration.** `ChoirPublisherRegistry` has a pure
  admission policy only. The production WebSocket/WebTransport registration
  does not admit two actual singers into two fully isolated verified streams.
  Authentication/media-ticket/capture generation routing must be enforced
  by server code. Neither remote participant IDs nor playback observations
  may be trusted as a transport credential.
- **No production MicTrack extraction with N=1 parity.** The experimental
  `ChoirAudioPrototype` bypasses the many proven (but still actively
  stabilized) AudioSession mechanisms: capture restarts, true packet gaps,
  drift/trim, clipping, limiter, readhead smoothing, forward-only
  corrections, freeze gates, and full authority checks. Swapping it into
  the live Mixer today would regress single Mic.
- **No authoritative native capture / room time mapping.** The bridge
  requires an independent zero-advance native-Mic sample anchor. It MUST
  not invent one from YouTube currentTime or WS arrival, and Content result
  sign/coordinate conversion must be confirmed against actual session
  sample mapping. The current tests supply known synthetic anchors.
- **No real timed output scheduler.** The 100 ms synthetic holdback is a
  deadline function, not an actual server schedule. Real late-packet
  deadlines, output catch-up/drop rules, burst backlog, clock slew,
  track starvation and route changes remain unimplemented.
- **No end-to-end browser/phone choir behavior.** Follower/secondary UI are
  pure policy, not mounted controls. Releasing a fake '+ Secondary Mic'
  button before backend support is specifically forbidden.
- **No safe live fallback installation.** Content > Sample/Boot candidate
  selection does not prove the *candidate is safe to apply immediately*.
  Mid-song advance jumps require explicit bounds, rate-limited smoothing,
  discontinuity detection, and Take freeze/generation policy. The current
  bridge can create a fresh anchor from a fallback; there is no production
  coordinator to perform all gates yet.

## Important risks (P1)

- **Acoustic reference:** Sample/YouTube observes player and sample clocks,
  not actual speaker-to-ear/voice-to-mic timing. An otherwise consistent
  fallback can have a stable device-specific acoustic offset. Boot probes
  may travel a different AudioContext/render path from YouTube; correlation
  confidence only proves probe detection, not that path equivalence is true.
  Compare both to confirmed Content on matching devices before automating.
- **Output route identity:** Singer Bluetooth/speaker/headphone changes
  (possibly without a capture generation bump) may invalidate Content and
  Boot. Current experiment identity tracks mic/backing sample rate,
  capture/room/Robot generations but not a verified output route epoch.
  The five-minute Boot TTL is not a substitute.
- **Song authority after main loss:** B's Mic can remain alive without any
  automatic promotion (by requirement), but the song clock may lose its
  leader. Preserve B's transport; do not mix unverified old/new song
  timelines until a separately authorized and validated controller restores
  the room clock.
- **Long-duration singer clock drift:** The sample-position read plan
  assumes a constant native-to-room rate. 44.1/48k conversion is not
  independent drift estimation. Persistent 50-100 ppm clock error and
  intermittent AudioContext slowdowns will de-align a song without the
  original single-Mic trim and fault handling.
- **Singer monitoring and mic bleed:** Everyone listening to a personal
  YouTube does not imply synchronized *speaker playback*. Content may fail
  with headphones, AEC or noise suppression; open speaker capture may
  introduce multiple audible copies of backing into the final mix.
- **Recording:** Current Take is the canonical mixed PCM only. Per-singer
  gap, capture-source and calibration provenance must be recorded before
  treating a Choir Take as reliable.

## Test evidence versus untested assumptions

Automated tests now cover:
- Real production Content analyzer on known signed offsets including two
  singers + synthetic harmonic interference.
- Independently stamped PCM impulse positions, separately mapped and
  rendered through the experimental MixBus.
- Real SampleSongFallback three-observation gate, staleness, same-song and
  source-generation checks; Boot arithmetic with live Robot delta and age cap.
- A lost primary keeping B's seat/audio and no automatic succession;
  reconnect expiry, stale transport and media epoch rejection.
- Native-rate fractional sampling, buffer wrap, late packets, fixed deadline,
  MixBus headroom, Follower paused seek and UI activation policy.

Not tested:
- Two genuine simultaneous phone Mic streams through real server sockets;
  real mobile YouTube timing or autoplay constraints; long-running drift;
  cross-device speaker delays; listener monitoring; Take; real-time
  physical voice alignment; load/perf at 48k under contention.

## Release gates / planned safe path

1. Leave all three PRs **Draft**. No migration of production single-Mic
   flows until known intermittent single-Mic failures are resolved.
2. Build a verified N=1 MicTrack extraction with golden PCM parity across
   capture loss, trim/slew, calibration/recording and source changes.
3. Introduce an authenticated, gated two-Publisher server harness using
   the true PCM packet pipeline. Ensure old transports cannot inject.
4. Attach independently validated per-singer Content and fallback anchors
   to the real capture timeline; guard fallback transitions and playback
   seeks. Add real output deadline/late-singer behavior.
5. Compare duet output against independently timestamped truth, then
   perform two-device Android/iOS and headphone/speaker tests.
6. Only once real audio and follower playback exist: mount the small
   '+ Secondary Mic' beside 'Take Over Mic'. No automatic main promotion.

**Product contract:** primary lost != secondary disconnected.
Primary lost != song controller automatically transferred.

## 2026-10-13 follow-up hardening — after initial audit

Additional patches in Draft #576:

- PCM ring writes now reject implausibly distant future packets using the
  trusted singer anchor, so one bogus sequence number cannot slide retention
  past samples that still belong to upcoming frames. The limit is in native
  sample coordinates; arbitrary capture origin does not require starting at 0.
- Song/backing epochs are now a room-wide invariant. A changed song or Robot
  backing cannot be inserted into the old Choir audio instance; create an
  explicitly new room audio epoch. A mismatched render is rejected before the
  room's read head is consumed. Actual seamless epoch handoff remains to build.
- Reinstalling an identical confirmed anchor does not reset the audible voice.
  Small updates (<=5 ms in this **experimental** policy) first fade out the
  old read trajectory, then adopt the new anchor at a frame boundary and fade
  back in. Larger jumps are rejected pending *explicit* revalidation/retirement
  rather than silently skipping/repeating a verse. The 5ms figure is a safe
  prototype guard, **not an empirically validated acceptable error**.
- Revoking a live anchor keeps a short fading output tail, retaining the MixBus
  headroom until the tail is inaudible. The evidence of the switch-over frame
  reports the *old* Content source that actually produced that frame.
- The local follower seeks before playback when it has a large paused/cued
  position mismatch, instead of playing the wrong verse until the next poll.
- `installAnchor(..., {takeFrozen:true})` explicitly refuses a new alignment
  while Take owns an immutable timeline. A future coordinator must provide the
  trusted Take state; a caller can omit this gate in the isolated prototype.
- A separate `test/choir-single-track-reference.test.ts` cross-checks a
  single impulse's **event coordinate** against the existing AudioSession
  output. This is *not* PCM bit-exact equivalence: the experimental voice
  path still lacks the real limiter, concealment, clock trim, clipping evidence,
  source-edge policy and full capture replacement machinery.

Tests include dangerous future PCM timestamps, same-anchor retry, 360-ms
fallback disagreement, 2-ms faded change, revoked-singer tail, paused follower
resumption, Take freeze, and the AudioSession single-source event reference.

### Remains mandatory before a production Choir switch

1. Extract an actual `MicTrack` from the present AudioSession and compare
   bit-exact Golden PCM/evidence for N=1 across the comprehensive existing
   test suite. The event-coordinate test above is only a starting checkpoint.
2. Integrate a **trusted** output/song epoch and native capture-to-room clock
   map; include bounded, independently measured drift correction.
3. Decide safety policy for *large* backup disagreements and output-device
   changes. Do not arbitrarily select a 5ms or 200ms switch for real phones.
4. Connect authenticated dual media upload, real fallback confirmation and
   Take freeze to the canonical server. Until then the small '+ Secondary Mic'
   button must remain absent from the deployed page.
