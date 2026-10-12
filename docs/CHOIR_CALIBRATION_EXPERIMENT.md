# Choir Content + fallback calibration experiment (stacked Draft)

This experiment is isolated from `server.ts` / production mix / UI.
Depends on the seating and timeline foundation in Draft PR #571.
**No primary-Mic automatic succession**, and no second production publisher.

## Measured versus estimated evidence

| Candidate | Computation | Trust |
| --- | --- | --- |
| Content | Existing `analyzeTimingCalibration` on each Mic + the *same* backing | Measured acoustic content offset after normal analyzer gates |
| Sample / YouTube | Existing `SampleSongFallback`, independently instantiated per singer | Time-coordinate estimate; *does not measure* acoustic playback latency |
| Boot | Existing `combineBootCalibration` on already-accepted probe legs + a **fresh** player delta | Measured probe path plus assumed equivalence to song path; still device-dependent |

Do **not** rank Boot above Sample merely because it played a probe; actual
phone and Robot AudioContext paths may differ from YouTube paths. Conversely
do **not** assert Sample is always better. This experiment exposes a per-singer
preference and both residuals relative to applicable Content, not a global
magic bias in milliseconds.

## Strict boundaries

- `activate(identity)` is the only lifecycle entry that changes song/capture/
  backing epoch. Delayed evidence for an older identity is rejected; never
  automatically re-activate a singer from an incoming telemetry packet.
- Individual singer has exactly one independent Content result, Sample pairing
  history, and accepted Boot probe-path baseline.
- A **failed Content retry within the same unchanged epoch does not erase**
  previously confirmed Content. External mapping decides `apply`, `hold`,
  or `revoke`. Hold means keep current applied read head; the experiment
  merely returns the held candidate as a diagnostic, **not** permission to
  install a different alignment.
- The existing Sample model needs THREE consecutive internally consistent
  observations from each side, shared video and playback rate, and reports
  no more than one second old. The experiment must never relax those gates.
- A Boot path is only retained after the caller asserts both actual probe legs
  passed their normal acceptance checks. The stored path difference does NOT
  freeze `delta`; Boot cannot be used without a fresh Robot/player delta.
- No source silently overwrites measured Content authority. Where Content is
  unavailable or revoked, an explicitly configured fallback preference chooses
  between **fresh usable candidates**. Both remain labeled estimates.
- Changing video/song epoch, mic capture generation, or backing generation
  resets every prior candidate for that singer only.
- When a singer leaves (including primary), other singers' states remain
  unchanged. This prototype does **not** promote a secondary.

## What the automated tests actually prove

- The real production Content analyzer processes two independently offset
  singer tracks against **one shared synthetic song**: +120 and -340 ms, with
  added singer-tone interference. The test asserts the known signed answer.
- The real Sample/YouTube estimator runs with separate three-observation series
  for two singers and can return different signed advances.
- A confirmed Content result wins over both fallback estimates. A rejected
  same-epoch retry retains confirmed Content; `hold` and `revoke` are explicit.
- Existing Boot arithmetic is reused with independently accepted input;
  the player-delta term is recomputed from fresh evidence, including 2x.
- Test evidence is scoped by singer/song/capture/backing generation; Sample
  expiration is enforced.

## Not proven by this experiment

- Actual mic and Youtube acoustic path equivalence, Safari/AEC/headphones,
  real arrival-time deadlines, media-ticket isolation, cross-device clock drift,
  mixed PCM, or post-seek robot mapping.
- Automatic choice of which fallback is more accurate on an unseen device.
- Any live functional secondary-Mic behavior; all production paths unchanged.

## Next work before exposing '+ Secondary Mic'

1. Double-check Content result conversion into per-singer room PCM sample anchors
   including follower seeks, playback-rate changes and capture clock trim.
2. Compare real-device Boot and Sample residuals to Content over multiple
   devices/captures, without learning a permanent offset from one lucky sample.
3. Extract per-singer MicTrack behind N=1 golden-PCM parity checks.
4. Implement a bounded voice bus, per-singer transport grace, and per-singer
   late-frame quality evidence. Keep all work Draft, off main.
