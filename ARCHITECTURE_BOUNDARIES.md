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
