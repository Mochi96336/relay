# Calibration model and verification

## Coordinates and sign

The room renders backing at session sample `s` and Mic at `s + advance`.
A positive advance reads later Mic samples; it does not add a playback delay.
Source sample counters are capture-local, generation-scoped and resampled onto
the room clock before measurement. Capture holes keep their positions and count
against evidence coverage; they must not collapse time.

`boot-calibration.ts` derives the wall-time target:

```text
advance = Mic path latency - backing path latency + Robot player delta / rate
```

The delta is Robot media position minus phone media position. Only that term
is divided by playback rate. Probe path latency is already wall time. Fine
tuning is subtracted from the resulting requested advance. Buffer budgets and
the actual arrival frontier can constrain it further.

## What each strategy knows

| Strategy | Evidence | What it cannot establish |
| --- | --- | --- |
| Boot | Separate known, nonrepeating probes through phone speaker/Mic and Robot/backing; player delta | Exact one-way transit: scheduling still assumes symmetric control transit after separating client preparation |
| Content | Matching music in raw Mic and backing capture; multiband features, distinct peaks and independent agreement windows | A unique lag for every song or a phone speaker path with no usable bleed |
| Sample/song fallback | Capture sample paired with each player's media position | Speaker-to-Mic latency, phone output latency and all capture buffering |

Boot provides a bounded baseline. Success or exhaustion settles that preference
and lets eligible content work proceed. A failed replacement retains fresh
confirmed authority; a provisional candidate cannot overwrite an existing
confirmed result. Candidate strategy, confirmed result provenance and the target
currently handed to the mixer are separate facts.

Content analysis searches the whole lag in one measurement. On the Robot route,
the backing evidence is mapped into a stable reference frame. The live target is
the reference lag plus the committed player-delta change divided by rate. Do
not add the absolute delta again: that would count it twice.

A follower seek changes media position without resetting capture sample indices.
The observed player delta can arrive before the new backing audio. The mapper
therefore retains committed content authority until PCM evidence proves the new
boundary. A rate change invalidates the old reference conversion rather than
reinterpreting it at the new rate.

## Evidence lifetime and authority

Collection and asynchronous results are fenced by session, capture generations,
source rates and source reference generation. Cancellation invalidates delayed
answers. Content collection and worker execution have separate bounded phases;
the production validator uses the same worker adapter with its own 20-second
analysis limit. A suspect drift needs a second independent agreeing window.
Read-only authority queries do not promote results or repair provenance.

Fresh Robot mapping noise keeps its jitter hold. A new confirmed revision
bypasses that hold once, but cannot consume itself during a mapping hold.
Applying an equal lag must still retire a different old slew target;
otherwise the next frame would walk away from the newly confirmed value.

## Measurement is not audible position

There are three relevant values: the requested alignment, the advance after
buffer/frontier constraints, and the advance used by the last emitted frame.
The latter is `heardMicAdvanceMs`. During a quiet wait it differs from
`appliedMicAdvanceMs`; neither an authority label nor a matching target proves
that the new alignment has been heard.

Small alignment corrections walk at 0.2% of real time. Corrections beyond
20 ms jump, waiting up to three seconds for both crossfade legs to be quiet.
The frontier has its own faster safety correction and can override that wait
when holding would consume audio that has not arrived.

`MicReadHead` owns a correction from request through walk/quiet wait to emitted
settlement. `timing-calibration-status.micReadHead` distinguishes
`acceptedCalibration` (target admission), `renderedCalibration` (the revision
actually used by emitted frames), and `settled` (the first complete frame that
finished the walk/quiet wait for that request). `requestId` tracks replacements
and `epoch` fences retired audio history. Nearby target updates share a bounded
quiet wait; a substantially different destination starts a fresh wait. A read-only query or a planned
frame cannot acknowledge audible output. Epoch retirement fences old frames;
replacement requests retire old motion. Inactive fallback work cannot restart
an acoustic correction's quiet wait.

`freezeFallbackAtHeard` withdraws an unheard fallback jump and stops its walk at
the last emitted fallback component. `resetFallbackForOwner` retires the previous
singer's baseline. These are distinct from retaining measurement authority while
its media mapping is unavailable.

Recording taps the same mixed PCM that Listen receives. It neither freezes
alignment nor forces a pending jump to land early. Content collection, validation,
fallback and the main/secondary read heads continue their normal live behavior.
Only audible test probes must wait until recording ends. Recording quality observes
any real timing error during a quiet wait; it cannot fix the WAV independently.

## Verification and physical limits

`take-listen-parity.test.ts` compares rooms with and without recording through
walks and delayed jumps, at zero and normal prebuffer. Every emitted frame must
match, and the finalized WAV payload must equal the exact Listen frames in its
addressed range. The read-head owner tests cover request supersession, cancellation,
epoch retirement and distinct accepted/emitted calibration revisions. DSP and
policy tests separately cover actual quiet-window selection and frontier safety.

The calibration, timing, boot, content, Robot mapping/transition and fallback
suites exercise sign, rate conversion, ambiguity rejection, authority retention,
context fencing, asynchronous cancellation and actual server protocol behavior.
These are deterministic PCM/protocol proofs. They do not measure present-day
phone speaker latency, Bluetooth routing, real network asymmetry or the audible
quality of every physical room. Those remain device measurements; sample/song
fallback must continue to be presented as approximate.
