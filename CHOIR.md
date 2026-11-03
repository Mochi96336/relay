# Choir (two singers)

A second singer, B, sings beside the Mic owner, A. Off by default; with it off, Relay runs exactly the single-Mic path, and `test/audio-session-golden.test.ts` holds that N=1 PCM byte-exact.

```bash
RELAY_CHOIR=1
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

`src/choir-runtime.ts` (`ChoirRuntime`) holds all of it; `server.ts` only calls in at its own seams (socket messages, binary frames and closes, each mix frame, captured PCM, the Robot's song anchors and probe replies). With `RELAY_CHOIR` unset there is no runtime, and second Mic messages are refused.

- **Join** (`choir-seat.ts`): who B is, and the one socket that speaks for B. Reports from any other tab of the same participant are ignored.
- **Claim** (`choir-media-claims.ts`): while B has no media, the server sends `choir-media-ready` to B's join socket, at once and every 3 s. B's join socket asks for a one-use claim, and a separate, freshly authenticated media socket of B's redeems it with its registration. The server names the transport; the page names nothing but its sample rate and codec.
- **Ingress** (`choir-ingress.ts`): B's packets, AudioPacket v2 PCM or Opus v3 (as the main Mic sends), checked and decoded. A bound socket carries nothing but B's packets, and never falls through to the main Mic or Robot routes. It carries B while B's join allows it, song or no song.
- **Room output**: B is a second `MicTrack` in the N=1 `AudioSession`, so Listen, Take and timing need no separate path. `MicTrack` holds each singer's PCM timeline, gain, limiter and read head.
- On B's page, `public/choir-ui.js` holds the second Mic's controls, `public/choir-media-client.js` claims and drives B's media socket, and `public/choir-secondary-capture.js` captures B's Mic.
- B's page plays the room's YouTube locally inside the normal Song player (`public/choir-follower.js`). It starts **muted**, which any browser lets a script play, so B keeps time at once; it is then unmuted. Where sound needs a tap (iOS pauses a scripted unmute), it plays on muted and B is asked to tap the YouTube player. B's playback position is never treated as room time. When room packets stop arriving, B's song keeps playing uncorrected for 10 s before it pauses, because a link blip of a couple of seconds must not stop the song B is singing to.

## Where B is placed

`ChoirRuntime` gives B a lag of its own on every mix frame, from the first of these that has one:

1. **Content** (`choir-content.ts`): while a song plays, six-second windows of each singer's PCM against the raw Robot backing, as the mixer holds them, analysed off-thread (`choir-content-analysis-worker.mjs`). B reads at A's advance plus (B − A). Both are measured against the same backing, so the difference holds in any coordinates.
2. **Test tone** (`choir-probe.ts`): the main Mic's three notes, played once on B's phone when B's capture arrives, and again when B presses its own Realign. B is silent in the room while they sound. B's lag is B's Mic path minus the Robot's own backing path (kept apart from whoever sings, so a headphone A does not block it) plus the Robot player offset.
3. **YouTube time**: B's page reports which capture sample was recorded at which point of its local YouTube (`choir-secondary-song-anchor`), the Robot reports the same for the backing, and the difference places B within seconds of the song playing.
4. **No song**: B reads at A's advance, and B's own frontier correction holds it back as far as B's audio actually arrives.

### B's song plays ahead when B is too late

The room cannot wait for B. The mixer reads at most prebuffer − safety ahead in B's audio (`RELAY_LIVE_PREBUFFER_MS` 400 − 200 = 200 ms live), and the rest of a larger lag is heard late. On 2026-10-31, B's YouTube-time lag was 1505 ms, so B was heard about 1.3 s late.

Instead, the server moves B's local song ahead of the room (`choir-lead.ts`):
- When B's YouTube-time lag is over 100 ms, or under −600 ms, the server sends `choir-secondary-lead { leadMs }` on B's join socket.
- The new lead puts B's lag at −100 ms. That leaves room for B's device latency (Bluetooth output and input), which YouTube time does not see. A lag below zero only reads B's history.
- B's follower seeks once, by the change in lead from where B's song is, so B's lag moves by exactly as much; a B already out of step (450 ms) goes back to room time + lead. Its anchors report the lead it was last moved to (`leadMs`).
- The server trusts B's lag only after four anchors at the current lead, so a measurement from before the move never counts twice.
- A move discards the Content measurement. While B's song plays ahead, YouTube time places B before the probe: the probe measures B's device as if B's player were at room time, and cannot see how far from it B's player was (the reason for the lead). With no song, B hears nothing ahead and the probe places B as before.
- The lead belongs to the singer: the same B back (a reload, a media reconnect) keeps it, and its page keeps it while the follower is hidden; another singer starts at no lead.
- Ahead of the room, B's song ends first, and it is not started over.

The journal line is `b-lead`. `b-lag`/`b-lag-source` carry `appliedMs`, the lag the mixer actually reads at that moment (it trails a jump in `lagMs` by a fade). `/statusz` has `audio.duetLead`, and `duetSecondary.appliedLagMs`.

Each song is measured afresh; a pause or seek keeps the last Content measurement. While a song plays, a lapse in every source keeps B where it was last placed. A change in B's lag over 100 ms fades B out, jumps and fades B back in, instead of the 1% slew taking minutes over it. While a Take records, an audible B keeps its lag, as A's alignment does.

## What Listen and Take hear

- A and B are summed, as two singers in one room would sound, so a harmony keeps the balance it was sung at. A sum that would pass one voice's ceiling is turned down at once and comes back up over 80 ms; a singer alone is untouched. B fades in and out over 50 ms.
- B's gain is B's own: the media registration carries the gain B's device remembers (default 24 dB), and B's Mic slider changes it while B is in.
- A voice fading out is never revived. Whoever sings next, the same B reconnecting or a C who took the seat, starts on a fresh `MicTrack` once the fade is done.
- The room shows B `joined` until B's audio connects, `aligning` while it is connected but not heard yet, and `singing` only while B is allowed to sound and B's PCM has reached the mix within the last 500 ms.
- B's gaps and starvation are part of the Take's quality evidence.

## Diagnostics

- `/statusz` `audio.duetSecondary` is B's track; `audio.duetIngress` counts B's accepted and rejected packets and its codec; `audio.duetContent`, `audio.duetProbe` and `audio.duetYoutube` show each placement source, and `duetYoutube.lagSource` which one B uses now.
- The server logs each step as `[choir] {"event":…}`: `b-joined`/`b-join-refused`, `b-claim`/`b-claim-refused`, `b-media-registered`, `b-media-disconnected`, `b-probe`, `b-realign`, `b-lag-source` (`content`, `probe`, `youtube-time` or `no-song`), `b-lag` (B's lag, or what the mixer reads of it, moved 20 ms or more; at most once a second), `b-lead` (B's song moved ahead or back), `b-lag-held` (song-time anchors lapsed, so B is held where it was), `b-heard`/`b-silent`, `b-pcm-stalled`/`b-pcm-resumed`, `b-revoked`, `b-left`. `b-page` is what B's page shows and plays (its local player state), so a B who hears no song can be explained. Its `lastAction` is the follower's last cue/pause/rate/seek/play with B's drift from the room at that moment, and `coasting` is true while B's song keeps playing on a room packet older than 1.5 s.

## Not done yet

- B has no capture clock trim.
- The two singers do not hear each other live: A's Listen is muted while A sings, and B's while its local YouTube plays. Only listeners and Takes get both voices.
