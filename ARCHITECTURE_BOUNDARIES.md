# Relay Architecture Boundaries

This document defines ownership boundaries that product and infrastructure code must preserve.

The rules are normative. Implementation may evolve, but a change that crosses one of these boundaries must either preserve the same ownership semantics or explicitly update this contract and its tests.

## 1. Recording lifecycle and recording history are different authorities

`TakeSession` owns exactly one live/current recording lifecycle:

- idle,
- recording,
- finalizing,
- ready or failed for the current Take.

It does **not** own durable recording history.

Durable finalized recordings belong to a recording-library/storage layer. That layer owns:

- listing previous recordings,
- reading recording metadata,
- persistence across Relay restarts,
- legacy artifact recovery,
- deletion/retention of artifact + metadata as one unit.

Starting a new Take is allowed to replace the current lifecycle record. It must not erase previously finalized recordings from durable history.

A product UI that needs comparison/history must read the recording library, not infer history from the current `TakeSession` payload or scan raw WAV files itself.

## 2. Realtime microphone evidence is local; mix health is diagnostic

The browser capture path owns realtime microphone level evidence.

The live meter may use evidence derived directly from the active local capture, such as peak/RMS measurements produced beside PCM capture. It must not depend on the server `mix-health` cadence for animation or realtime input feedback.

Server `mix-health` remains appropriate for slower derived/diagnostic information such as:

- gain recommendations,
- mix-path health,
- transport/drop evidence,
- operational diagnostics.

The server health cadence must not be increased merely to make a UI meter appear realtime.

A new microphone capture epoch must retire local level state and any server recommendation that belonged to the previous capture before accepting fresh evidence.

## 3. Product status and diagnostics are separate surfaces

Normal product UI consumes product-semantic state. Diagnostics consumes implementation evidence.

`ProductStatus` must be sufficient to tell a normal UI what user-visible problem exists without requiring that UI to read `/readyz`, raw subsystem state, logs, or technical diagnostics.

Rich product issues should carry product-facing semantics such as:

- issue code,
- severity,
- affected capability/capabilities,
- an observable cause that does not invent unavailable history,
- recovery ownership or action.

Diagnostics may expose implementation details such as routes, transport identities, sample/timing evidence, Robot lifecycle details, calibration evidence, and raw subsystem observations. Those details must not become a required intermediate navigation layer for normal product recovery.

If the product layer only knows current availability, it must describe current availability. Terms such as `disconnected`, `lost`, or other transition claims require actual transition/history evidence.

## 4. Compatibility projections stay compatibility projections

When a richer replacement is introduced for an existing product contract, the compatibility field must retain its previous runtime shape unless an intentional versioned breaking change is made.

For ProductStatus, the legacy `attention` field remains the compact highest-priority projection:

```text
{ code, scope, severity }
```

Richer issue semantics belong to `issues[]`; they must not silently widen `attention` and call that backward compatible.

## 5. UI must not reconstruct domain authority

The UI may render, localize, group, and prioritize domain output. It must not recreate authoritative domain decisions from lower-level telemetry when a product/domain contract already owns that decision.

Examples:

- recording history comes from the recording library, not filesystem guesses in the browser;
- realtime Mic level comes from local capture evidence, not a server health snapshot;
- product recovery comes from product issues/actions, not by scraping Diagnostics;
- technical evidence may explain a problem in developer tooling but does not replace the product issue contract.

## 6. Contract tests belong with the owning boundary

Architecture boundaries should be enforced at the narrowest owner rather than collected in one giant architecture test suite.

Examples:

- recording tests prove that current Take lifecycle can advance while durable history retains earlier recordings;
- browser-audio tests prove that the Mic meter uses local capture evidence and that capture epochs cannot reuse stale server recommendations;
- product-status tests prove that rich issues are self-contained while legacy compatibility fields keep their exact runtime shape.

This keeps future failures close to the code that owns the rule and avoids turning architecture validation into another cross-cutting monolith.

## 7. Timing strategy, timing authority, and the Robot route are three different facts

Timing is measured by more than one strategy, and the parts of the system that
ask about it want different questions answered. Conflating them is what lets a
correct-looking change to one gate silently contradict another.

Keep these separate:

- **Route** is a physical fact: whether this room's backing and Source are the
  Robot pair. It must not be inferred from whether a strategy is *enabled*; a
  configuration flag that turns off boot probing cannot also turn off Robot
  content authority, mapping readiness, or Robot Take quality semantics.
- **Candidate strategy** is what is being measured right now.
- **Applied authority** is what produced the result currently serving the
  mixer. `CalibrationSession` deliberately keeps the previous confirmed result
  serving while a replacement is measured, so a candidate of one kind
  alongside confirmed authority of another kind is an ordinary state, not an
  error.
- **Fallback measurement** is a settled result being retained for later use.

Provenance decisions - which result a validator baselines against, which
reference frame a media transition may carry forward - read applied authority.
Reading the candidate there attributes one strategy's measurement to another.

### A measurement is a stage only if it occupies the room

Timing is measured by strategies that cost the room very different things, and
product state must follow the cost, not the word "calibration".

- The **boot probe** plays its own chimes through the phone and the Robot
  output and needs both captures to itself. While it runs the room really is
  getting ready, so it is a preparation stage: the lifecycle says `preparing`
  and a Take waits for it.
- **Content calibration** is a tap on audio the room is already making. It
  changes nothing the singer hears and holds nothing up, so presenting the room
  as preparing - or refusing a Take - would be describing a measurement rather
  than the room.

The same distinction decides what the timing surface reports. A background run
deliberately leaves the previous confirmed result serving the mixer, so the
room's timing state is that applied authority; `calibrating` is the honest
answer only while nothing trustworthy is applied, where it also outranks
`stale`/`fallback`, whose recovery is the recalibration already running.

Not being a stage is not permission to run through a Take. A Take that starts
while a content run is collecting stands that run down, because confirming it
would move the mixer's alignment into the middle of the recording. Standing
down is not a failure and must not be reported as one. This is the same policy
as refusing to *begin* content work during a Take, applied from the other side.

### Strategy preference is bounded and terminates both ways

A bounded fast strategy is a baseline, not a gate on the strategies that
replace it. Anything that waits for such a strategy must wait for it to
**settle** - produce a usable result, or spend its bounded attempts - never for
it to *fail*. A gate keyed on failure never opens on the healthy path.

A bounded run must also be able to reach a terminal state from every topology
it is admitted in. Admitting one leg of a multi-leg measurement whose other leg
cannot exist produces a run that waits forever without spending an attempt.
Automatic scheduling and product-advertised actions must share one admission
policy rather than growing a second, laxer copy.

### Revoking a media mapping is one transaction

Every event that invalidates the Robot content mapping performs the *same*
teardown. Differences between callers belong in that transaction's parameters,
not in which steps each call site remembers.

Two of those steps are easy to omit and expensive to miss:

- **Invalidating the reference frame.** Clearing a mapping without advancing
  the generation it is scoped to leaves the confirmed result still matching the
  live context, so it becomes eligible to be re-applied as soon as new
  telemetry makes the mapper ready. A fail-closed fence has to fail closed.
- **Aborting a pending analysis.** Analysis is asynchronous and its promotion is
  stamped with the context that is live when the worker answers, not when the
  audio was captured. Any generation change that outlives a running analysis
  promotes evidence measured in a frame that no longer exists.

### Evidence length is not evidence

Capture collectors keep missing PCM as zeros so sample positions stay truthful.
A window's length is therefore its span, not the amount of audio in it. Every
consumer that hands a window to a correlator must bound the gap as well as the
span, and all of them must use the same bound.

### A room has one source discontinuity authority

Only the transport that currently owns playback may report a seek that
invalidates mapping and calibration. A development adapter holds that authority
only while no production Source does.
