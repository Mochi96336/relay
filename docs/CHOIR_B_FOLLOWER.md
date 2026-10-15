# B local YouTube follower — experimental contract

This is a stacked Draft based on #576, not a production rollout. It adds a
**separate, opt-in B local YouTube iframe**, controlled by the existing
authoritative room-song snapshot. It does NOT enable N=2 Monitor, Take, or
Mic sample alignment, and never promotes B to room song controller.

## B screen

After B accepts the authenticated second-Mic invitation and both experimental
flags are enabled, B sees a **local backing** card beneath the normal room-song
observer. Only B has the Enable local backing button. Neither consent nor
microphone registration autoplays YouTube. A phone may still require a direct
Play tap inside its visible YouTube iframe.

The card shows B local player time / reported room song time. This is an
**approximate playback difference**, not a Content/Sample/Boot Mic calibration
or a physical ear-to-Mic latency measurement. The card separately says whether
the experimental B PCM socket is linked. Its audio is not a live duet Monitor.

## Four distinct time axes

1. Room song media position: video ID, playback rate, play/pause/Seek, as held by
   the single authorized controller and exposed by `room-song-status`.
2. B local iframe media position: own `getCurrentTime()`, possibly buffering,
   device-specific speaker delay and blocked mobile autoplay. B cannot publish
   this as an authoritative room timeline.
3. B native PCM capture time: independent generation/sample cursor/AudioContext.
   Its packet arrival and native sample index are NOT the local YouTube timestamp.
4. Server room output sample clock: the only place MicTrack A/B and Robot Backing
   are eventually combined. Content aligns *each native Mic* against the same
   Robot reference; fallback methods are not yet wired to live N=2.

The follower projects `room-song-status.serverTime` at reception time using the
browser monotonic clock. This projection **does not include a calibrated
server-browser clock offset or measured one-way transmission delay**. It is a
coarse follower, not a timing proof. Never use it to set B's Mic read-head offset.

## Local follower decisions

- Separate B click instantiates its local YouTube iframe, showing real controls.
- Only a valid live room status, with an idle handoff, may drive the follower.
- A paused room pauses B. A song change cues the new video in B.
- Local drift below 450ms is tolerated. Larger differences may Seek, no more
  than once in 3 seconds; do not continuously change playback rate to chase
  drift. Follow the room's actual playback rate when changed.
- A stale room (>1500ms without a fresh room-status packet), missing room
  authority or handoff pauses B, not A. Authorization revocation or B becoming
  the room holder destroys the separate iframe.
- No forwarding B `relay:youtube-telemetry`, song commands, session mutations,
  player controls or user credentials to the server.
- Double flags default off; production N=1 unchanged.

## Release gates, not completed here

- Actual iOS Safari/Android autoplay and headphone behavior.
- Repeated SongSession Seek, pause/resume and room-controller transition tests
  with source-authentic song reference.
- B Sample and Boot fallback adapter, independently bounded and verified.
- Real dual phone A/B Content correlation and clock drift measurements.
- A separate authorized N=2 Monitor and a byte-exact default-off N=1 check.

Do not merge to main or claim full live choir compatibility based on these UI
contracts alone.
