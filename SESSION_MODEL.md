# Relay session model

Relay has one intentionally lightweight room. It does **not** have user accounts. The server needs only enough identity to answer three product questions:

1. who is currently here;
2. who owns the single microphone slot;
3. whether somebody else may safely take that slot.

The important boundary is that a **person**, a **mic lease**, and a **WebSocket transport** are three different things. They must not share one lifecycle.

## Identity

A browser creates a random `participantId` and a random display nickname on first use. Both are client-local convenience identity, not authentication. The nickname is editable inline and the server sanitizes it before broadcasting it.

Participant binding is explicit per WebSocket. Human presence / publisher / monitor sockets include the participant ID and nickname when they connect. Relay does **not** infer a human identity from ambient origin-wide cookies, so `source.html`, robot sources, backing capture and other infrastructure sockets cannot accidentally keep somebody online.

A connection handshake proves liveness only. It does not rename an existing participant: a stale tab reconnecting with an old locally cached nickname cannot undo a newer explicit `participant-rename` action.

A participant may own multiple WebSocket connections at once. One transport closing therefore does not by itself mean the person left the room.

## Presence lifecycle

```text
first explicit participant connection
  -> connected participant

one of several participant sockets closes
  -> still connected

last participant socket closes
  -> participant reconnecting grace

same participant reconnects inside grace
  -> connected again

grace expires
  -> participant removed
  -> mic released too, if they still owned it
```

The participant reconnect grace exists only to stabilize **presence**. It is not the lifetime of the microphone lease.

## Microphone ownership

The microphone is a server-authoritative lease owned by `participantId`, not by a WebSocket object.

Ownership is never reserved by a presence-only action. It is committed only while the server is accepting a ready publisher transport. This prevents a participant from owning the mic without ever succeeding in opening a microphone.

Normal publisher registration succeeds only when the mic is free or already belongs to the same participant. A second participant never silently evicts the current owner.

## Confirmed takeover is transport-first

A deliberate takeover is allowed after an inline confirmation, but confirmation does **not** immediately change server ownership.

The client first prepares the real capture path:

```text
confirm takeover
  -> getUserMedia
  -> AudioContext / AudioWorklet ready
  -> publisher WebSocket ready
  -> register publisher with expectedOwnerId
```

Only then does the server perform one synchronous compare-and-swap + publisher bind:

```text
expected owner == current owner
  -> bind new publisher + change owner
  -> then revoke the previous publisher

current owner released meanwhile
  -> bind new publisher + acquire the free mic

current owner changed to somebody else
  -> reject the stale confirmation
  -> leave the current singer untouched
```

There must never be a broadcast state where a successful takeover has already changed `micOwnerId` but the winning publisher has not yet been bound. If microphone permission, AudioWorklet setup or connection fails before registration, the previous singer keeps the mic.

## Publisher transport lifecycle

Mic ownership and PCM transport remain separate after the atomic registration:

```text
participant presence
  -> online / reconnecting / gone

mic lease
  -> free / owned

publisher transport
  -> connected / reconnecting / superseded
```

An **unexpected network disconnect** starts a short, independent mic-transport reconnect grace. During that grace the room may show the same owner with `micConnected: false`. Reconnecting the same capture cancels the deadline and preserves its timeline/calibration context.

If no matching publisher returns before the mic-transport grace expires, the server releases the mic even when that participant's presence socket is still online. This prevents an online page with a dead capture from holding the microphone indefinitely.

An intentional **Stop**, an ended microphone track, or an explicit **Release mic** releases the lease instead of waiting for the presence lifecycle.

## Revocation and multiple tabs

Losing publisher authority is protocol state, not a transport error.

- `mic-revoked`: another participant now owns the microphone.
- `publisher-superseded`: another publisher transport for the same participant became authoritative.
- network socket failure: transport may reconnect automatically.

A revoked or superseded publisher stops local capture and does **not** enter the automatic reconnect loop. This prevents two tabs sharing one participant ID from repeatedly replacing each other.

## Timing evidence

A real ownership change invalidates microphone timing evidence before it can affect the new singer. A same-capture network reconnect may preserve the capture generation and timeline. A genuinely new capture generation invalidates timing even when the participant ID is unchanged.

## Scope boundary

This model intentionally does not introduce:

- accounts, passwords, email or OAuth;
- persistent server-side user records;
- friends, chat or social profiles;
- host/admin roles;
- a microphone queue.

Those can be added only if a real product need appears. Presence + nickname + single server-authoritative mic lease is the current domain boundary.
