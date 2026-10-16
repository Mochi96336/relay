# Choir (two singers)

Experimental and **off by default**. With both flags unset, Relay runs exactly the single-Mic path. `test/audio-session-golden.test.ts` holds the N=1 PCM byte-exact.

```bash
RELAY_CHOIR_SHADOW=1
RELAY_CHOIR_MEDIA_EXPERIMENT=1   # only together with RELAY_CHOIR_SHADOW
```

## Roles

- **A** is the normal Mic owner and keeps the existing Take Mic / Take Over Mic flow and its publisher socket.
- **B** is invited by A through **+ 副 Mic** and must accept on B's own page.
- B never becomes the N=1 publisher and has no room song commands.
- If A leaves, B keeps its seat but is **not promoted**. Someone has to take the Mic explicitly.

## Path

```text
A  existing publisher ─┐
Robot existing backing ┼─> trusted source mirror ─> CanonicalChoirMixExperiment
B  AudioPacket v2 WS  ─┘                              MicTrack(A) + MicTrack(B) + MixBus
                                                      one room clock, one output deadline
```

- B's page plays the room's YouTube locally inside the normal Song player (`public/choir-follower.js`). B's playback position is never treated as room time.
- Each singer gets their own Content calibration: a six-second window of their own PCM against the Robot backing, analysed off-thread (`choir-content-analysis-worker.mjs`). The server then checks again that the room, song, media and capture are unchanged before it accepts the result.
- `MicTrack` is the per-singer state that `AudioSession` used to hold directly: PCM timeline, gain, limiter, clock trim, read head. N=1 uses exactly one `MicTrack`.

## Not done yet

- The rendered duet PCM is **discarded**. It does not reach Listen or Take yet.
- Real two-device runs have not happened yet: phone capture clocks, local YouTube drift, Bluetooth paths, network jitter.
