# Choir (two singers)

Experimental and **off by default**. With both flags unset, Relay runs exactly the single-Mic path. `test/audio-session-golden.test.ts` holds the N=1 PCM byte-exact.

```bash
RELAY_CHOIR_SHADOW=1
RELAY_CHOIR_MEDIA_EXPERIMENT=1   # only together with RELAY_CHOIR_SHADOW
```

## Roles

- **A** is the normal Mic owner and keeps the existing Take Mic / Take Over Mic flow and its publisher socket.
- **B** is anyone else. B presses **+ 副 Mic** in the Mic row, and that one tap starts B's microphone and joins B to whoever holds the Mic. A does not approve and cannot remove B.
- There is one B at a time. Like the Mic itself, the second Mic can be taken over: while someone is B, others see **接手副 Mic**, and pressing it replaces B (`revoked`, reason `replaced`). There is no extra card; the heading carries the duet's state, and one line under the Mic row says why a join failed or ended.
- A join is not tied to a song. It lasts while A holds the Mic and B's page stays connected, across pauses, seeks and Takes.
- Whenever a song plays and there is no duet room, the server creates one (`beginJoinedChoirRoom()`) and sends B `choir-room-ready`, again every 3 s until B claims it. B's page then claims its media socket. A seek or song change retires the room, and the next one is created the same way.
- B never becomes the N=1 publisher and has no room song commands.
- If A gives up the Mic, B's join ends. B is **not promoted**; someone has to take the Mic explicitly.

## Path

```text
A  existing publisher ─┐
Robot existing backing ┼─> trusted source mirror ─> CanonicalChoirMixExperiment
B  AudioPacket v2 WS  ─┘                              MicTrack(A) + MicTrack(B) + MixBus
                                                      one room clock, one output deadline
```

- B's page plays the room's YouTube locally inside the normal Song player (`public/choir-follower.js`). B's playback position is never treated as room time.
- That local song starts **muted**, which any browser lets a script play, so B keeps time and is aligned by YouTube time at once; it is then unmuted. Where sound needs a tap (iOS pauses a scripted unmute), it goes on playing muted and B is asked to tap the YouTube player.
- Each singer gets their own Content calibration: a six-second window of their own PCM against the Robot backing, analysed off-thread (`choir-content-analysis-worker.mjs`). The server then checks again that the room, song, media and capture are unchanged before it accepts the result.
- `MicTrack` is the per-singer state that `AudioSession` used to hold directly: PCM timeline, gain, limiter, clock trim, read head. N=1 uses exactly one `MicTrack`.

## What Listen and Take hear

The room output is still the N=1 `AudioSession`, so Listen, Take and timing need no separate path. Once the duet room is `duet-ready` and A still owns the Mic, B joins that output as a second `MicTrack` (`syncDuetOutput()` in `server.ts`):

- Until Content has measured both singers, B is placed by **YouTube time**, as the main Mic's sample/song fallback: B's page reports which capture sample was recorded at which point of its local YouTube (`choir-secondary-song-anchor`), the Robot reports the same for the backing, and the difference gives B's lag within seconds of the song playing.
- Once Content has both, B's lag is A's advance plus (B − A) from the duet room. Both singers are measured against the same Robot backing, so their difference holds in any coordinates.
- A and B are summed, as two singers in one room would sound, so a harmony keeps the balance it was sung at. A sum that would pass one voice's ceiling is turned down at once and comes back up over 80 ms; a singer alone is untouched. B fades in and out over 50 ms.
- While a Take records, an audible B keeps its lag, as A's alignment does.
- `/statusz` shows B under `audio.duetSecondary`. `audio.duetIngress` counts B's accepted and rejected frames, `audio.duetRoom` gives the duet room's state, `audio.duetContent` shows the Content worker's counters and last failure, and `audio.duetYoutube` shows the YouTube-time anchors and which source B's lag uses.
- The server logs each step as `[choir] {"event":…}`: `b-joined`, `room`, `b-claim`, `b-media-registered`, `b-lag-source`, `b-heard`/`b-silent`, `b-left`. `b-page` is what B's page shows and plays (its local player state), so a B who hears no song can be explained.

The duet room's own rendered PCM is still only proof evidence and is not sent anywhere.

## Not done yet

- Real two-device runs have only just started: phone capture clocks, local YouTube drift, Bluetooth paths, network jitter.
- B has no capture clock trim, and B's gaps are not in the Take's quality evidence yet.
- B's gain is the default 24 dB; B's own remembered gain is not sent yet.
