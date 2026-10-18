# Choir (two singers)

A second singer, B, sings beside the Mic owner, A. Off by default; with it off, Relay runs exactly the single-Mic path, and `test/audio-session-golden.test.ts` holds that N=1 PCM byte-exact.

```bash
RELAY_CHOIR_SHADOW=1
RELAY_CHOIR_MEDIA_EXPERIMENT=1   # both are needed
```

## Roles

- **A** is the normal Mic owner and keeps the existing Take Mic / Take Over Mic flow and its publisher socket.
- **B** is anyone else. B presses **+ 副 Mic** in the Mic row, and that one tap starts B's microphone and joins B to whoever holds the Mic. A does not approve and cannot remove B.
- There is one B at a time. Like the Mic itself, the second Mic can be taken over: while someone is B, others see **接手副 Mic**, and pressing it replaces B (`revoked`, reason `replaced`). There is no extra card; the heading carries the duet's state, and one line under the Mic row says why a join failed or ended.
- A join is not tied to a song. It lasts while A holds the Mic and the socket B joined from stays open, across pauses, seeks and Takes.
- If A gives up the Mic, B's join ends. B is **not promoted**; someone has to take the Mic explicitly.
- B never becomes the N=1 publisher and has no song commands. A local file song (A's phone only) refuses joins.

## Path

```text
A      publisher socket ──────────> MicTrack(A) ─┐
B      media socket ──> ingress ──> MicTrack(B) ─┼─> MixBus ─> Listen, Take
Robot  backing socket ───────────────────────────┘
```

B's join socket (its ordinary page socket) carries the join, the claim and B's reports; only its separate media socket carries audio.

- **Join** (`choir-secondary-consent-experiment.ts`): who B is, and the one socket that speaks for B. Reports from any other tab of the same participant are ignored.
- **Claim** (`choir-secondary-media-ticket-experiment.ts`): while B has no media, the server sends `choir-media-ready` to B's join socket, at once and every 3 s. B's join socket asks for a one-use claim, and a separate, freshly authenticated media socket of B's redeems it with its registration. The server names the transport; the page names nothing but its sample rate and codec.
- **Ingress** (`choir-secondary-pcm-ingress-experiment.ts`): B's packets, AudioPacket v2 PCM or Opus v3 (as the main Mic sends), checked and decoded. A bound socket carries nothing but B's packets, and never falls through to the main Mic or Robot routes. It carries B while B's join allows it, song or no song.
- **Room output**: B is a second `MicTrack` in the N=1 `AudioSession`, so Listen, Take and timing need no separate path. `MicTrack` holds each singer's PCM timeline, gain, limiter and read head.
- B's page plays the room's YouTube locally inside the normal Song player (`public/choir-follower.js`). It starts **muted**, which any browser lets a script play, so B keeps time at once; it is then unmuted. Where sound needs a tap (iOS pauses a scripted unmute), it plays on muted and B is asked to tap the YouTube player. B's playback position is never treated as room time.

## Where B is placed

`syncDuetOutput()` in `server.ts` gives B a lag of its own, from the first of these that has one:

1. **Content** (`duet-content.ts`): while a song plays, six-second windows of each singer's PCM against the raw Robot backing, as the mixer holds them, analysed off-thread (`choir-content-analysis-worker.mjs`). B reads at A's advance plus (B − A). Both are measured against the same backing, so the difference holds in any coordinates.
2. **Test tone** (`duet-probe.ts`): the main Mic's three notes, played once on B's phone when B's capture arrives, and again when B presses its own Realign. B is silent in the room while they sound. B's lag is B's Mic path minus the Robot's own backing path (kept apart from whoever sings, so a headphone A does not block it) plus the Robot player offset.
3. **YouTube time**: B's page reports which capture sample was recorded at which point of its local YouTube (`choir-secondary-song-anchor`), the Robot reports the same for the backing, and the difference places B within seconds of the song playing.
4. **No song**: B reads at A's advance, and B's own frontier correction holds it back as far as B's audio actually arrives.

Each song is measured afresh; a pause or seek keeps the last Content measurement. While a song plays, a lapse in every source keeps B where it was last placed. A change in B's lag over 100 ms fades B out, jumps and fades B back in, instead of the 1% slew taking minutes over it. While a Take records, an audible B keeps its lag, as A's alignment does.

## What Listen and Take hear

- A and B are summed, as two singers in one room would sound, so a harmony keeps the balance it was sung at. A sum that would pass one voice's ceiling is turned down at once and comes back up over 80 ms; a singer alone is untouched. B fades in and out over 50 ms.
- B's gain is B's own: the media registration carries the gain B's device remembers (default 24 dB), and B's Mic slider changes it while B is in.
- A voice fading out is never revived. Whoever sings next, the same B reconnecting or a C who took the seat, starts on a fresh `MicTrack` once the fade is done.
- The room shows B `joined` until B's audio connects, `aligning` while it is connected but not heard yet, and `singing` only while B is allowed to sound and B's PCM has reached the mix within the last 500 ms.
- B's gaps and starvation are part of the Take's quality evidence.

## Diagnostics

- `/statusz` `audio.duetSecondary` is B's track; `audio.duetIngress` counts B's accepted and rejected packets and its codec; `audio.duetContent`, `audio.duetProbe` and `audio.duetYoutube` show each placement source, and `duetYoutube.lagSource` which one B uses now.
- The server logs each step as `[choir] {"event":…}`: `b-joined`/`b-join-refused`, `b-claim`/`b-claim-refused`, `b-media-registered`, `b-media-disconnected`, `b-probe`, `b-realign`, `b-lag-source` (`content`, `probe`, `youtube-time` or `no-song`), `b-heard`/`b-silent`, `b-pcm-stalled`/`b-pcm-resumed`, `b-revoked`, `b-left`. `b-page` is what B's page shows and plays (its local player state), so a B who hears no song can be explained.

## Not done yet

- B has no capture clock trim.
- The two singers do not hear each other live: A's Listen is muted while A sings, and B's while its local YouTube plays. Only listeners and Takes get both voices.
