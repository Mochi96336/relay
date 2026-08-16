# Relay Observation Contract

`GET /api/status/v1` is the stable read-only observation surface for another system such as `home-pi`.

It is deliberately smaller and more stable than Relay's WebSocket protocol and does not expose domain-owned runtime identities.

## Boundary

The contract reports only long-lived workload observations and anonymous aggregate runtime evidence:

- Relay workload state: `idle`, `live`, `degraded`, or `fault`.
- Process-relative uptime and source-generated observation time.
- Backing and microphone transport/streaming state.
- Aggregate participant counts and whether a microphone lease exists.
- Robot route/source visibility and player-delta freshness.
- Calibration mode/staleness.
- Mix diagnostics and current faults/warnings.

It does **not** report:

- participant IDs or nicknames,
- the microphone owner's identity,
- `RELAY_KEY` or any credential,
- room/session IDs,
- takes or recordings,
- publisher capture generations,
- voice-session/player-session identities,
- arbitrary logs or internal database state.

Those are Relay domain/runtime context and stay inside Relay unless a future version explicitly promotes a stable aggregate fact.

## Versioning

The payload carries:

```json
{
  "schema": "relay.observation.v1",
  "generatedAt": "2026-08-17T00:00:00.000Z"
}
```

Consumers must key on `schema`, not on incidental fields from `/statusz` or WebSocket messages. Additive fields may be introduced within v1. Removing or changing the meaning/type of an existing v1 field requires a new schema version.

`generatedAt` is Relay wall-clock time. A consumer should still record its own fetch time and network freshness rather than assuming clock synchronization.

## State semantics

`workload.state` reuses Relay's current route interpretation:

- `idle`: no backing, microphone, or robot source is active. This is normal and `ok` remains true.
- `live`: activity is present and no known fault/warning currently applies.
- `degraded`: activity is present and Relay has a warning, but audio can still continue using a fallback.
- `fault`: Relay has positive evidence of a broken active path, such as an open source transport that stopped sending audio.

`workload.ok` is false only for `fault` evidence. Warnings do not clear `ok`.

The contract does not claim end-to-end singing quality or Discord health. It reports only facts Relay itself can currently observe.

## Privacy and access

Like `/healthz` and `/statusz`, the v1 observation endpoint is currently unauthenticated. Because of that, the payload is intentionally identity-free and credential-free. If the deployment boundary changes in the future, authentication can be added without changing the observation semantics.

## Consumer ownership

Relay owns the meaning of these fields. A consumer such as `home-pi` owns:

- fetch success/failure,
- consumer-side freshness/staleness,
- placement in a capability view,
- any explicit cross-system interpretation policy.

Consumers should not scrape Relay logs, inspect private in-memory/runtime structures, or reconstruct richer Relay state from implementation details when this contract already provides the supported observation.
