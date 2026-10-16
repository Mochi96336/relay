# B local YouTube follower — one Song surface (Draft #588)

Scope: stacked on #576, **default-off**, no N=2 Monitor/Take, no auto primary
succession and no claim of physical A/B song alignment.

## B interaction

Keep exactly Relay's existing **Song** area. A sees and controls the normal
YouTube player. After authenticated B consent in the double-gated Choir
experiment, B's observer Song switches from the artwork to a separate local
YouTube iframe **in that same player shell**, with the same song title and
time row. B never gets an extra card or mandatory "enable backing" button.

The B iframe prepares/loads automatically and attempts to follow the room.
On mobile Safari/Chrome the browser may refuse scripted audible playback;
only when the YouTube API reports autoplay blocked, or the local player stays
paused after an actual attempt, a minimal note says to tap Play **on the same
existing player**. Such a tap is a fallback, not an additional Relay join step.

B's local YouTube replaces B's **room Monitor sound**, not the user's mute
preference. Only while B's local follower reports actual playback, Listen overlays the
existing `song-owned` forced-mute reason. Loading, autoplay refusal, playback
failure, stale room status, withdrawing consent or changing roles removes
the overlay. This avoids hearing the same Robot accompaniment twice on B.

The primary room player's iframe stays separate and hidden in B's observer
role; its production ownership and telemetry code remain untouched.
The B iframe never dispatches room commands or authoritative telemetry.
Withdrawal/role change retires it; stale room clock pauses local B playback.

## Time coordinates, kept separate

1. The single room SongSession media position is controlled by A and comes
   from `room-song-status`.
2. B's own YouTube `getCurrentTime()` appears as **current / total** in the
   same Song time readout (like A), not an extra B-versus-room clock on-screen.
   The estimated room position is **not** calibrated
   against device speaker latency or measured one-way network delay.
3. B's independent PCM native capture generation and sample cursor are
   separate from the iframe clock.
4. The Server output clock is shared by A, B and Robot; each singer requires
   independently accepted Content or an explicitly safe backup calibration.

Follower policy currently tolerates <450ms local media drift, avoids
repeated Seek for 3s, and rejects stale/invalid room snapshots. **Do not**
treat this as sub-50ms singing accuracy or use the displayed difference as
`MicTrack.advanceMs`.

## Before physical duet testing

Real Android/iOS YouTube playback and autoplay, headphone/route-change
measurements, real B Content evidence, verified Sample/Boot transitions and
explicit N=2 Monitor remain outstanding. Existing N=1 behavior stays behind
both flags being off. Do not merge this stacked PR to main.


## Follower failure recovery

Player initialization has a ten-second deadline, with at most three attempts
separated by five seconds. Retired iframe callbacks cannot revive playback or
mute Monitor. Leaving and rejoining the follower resets the retry budget.
A rejected playback-rate request is attempted once per target rate/video;
play and position correction continue even when the player refuses that rate.
