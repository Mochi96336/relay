# Relay session model

Relay has one intentionally lightweight room. It does **not** have user accounts. The server needs only enough identity to answer three product questions:

1. who is currently here;
2. who owns the single microphone slot;
3. whether somebody else may safely take that slot.

## Identity

A browser creates a random `participantId` and a random display nickname on first use. Both are client-local convenience identity, not authentication. The nickname is editable inline and the server sanitizes it before broadcasting it.

A participant may own multiple WebSocket connections at once. The presence socket, microphone publisher socket and monitor socket all count toward the same participant presence. One transport closing therefore does not mean the person left the room.

## Presence lifecycle

```text
first connection
  -> connected participant

one of several sockets closes
  -> still connected

last socket closes
  -> reconnecting grace

same participant reconnects inside grace
  -> connected again, same mic ownership

grace expires
  -> participant removed
  -> mic released if they still owned it
```

The reconnect grace prevents a transient mobile-network/WebSocket failure from making the person and microphone ownership flicker out of existence.

## Microphone ownership

The microphone is a server-authoritative lease owned by `participantId`, not by a WebSocket object.

Normal acquisition is allowed only when the mic is free or already belongs to the same participant. A second participant never silently evicts the current owner.

A deliberate takeover is allowed after an inline confirmation. The confirmation carries the owner ID the client actually saw. Server takeover is compare-and-swap:

```text
expected owner == current owner
  -> takeover succeeds

current owner released meanwhile
  -> acquire the now-free mic

current owner changed to somebody else
  -> reject the stale confirmation
```

This prevents an old confirmation from accidentally taking the microphone from a third person.

## Publisher transport

Mic ownership and PCM transport are separate state:

```text
participant
  -> may own mic

publisher WebSocket
  -> may currently transport that owner's PCM
```

A publisher disconnect does not immediately release mic ownership because the capture transport already has automatic reconnect behavior. The room can therefore show an owner whose mic transport is reconnecting. Anyone else can still deliberately take over after confirmation, so an abandoned device cannot permanently lock the room.

When ownership actually changes to another participant, the old publisher transport is revoked immediately and its timing evidence is invalidated. The old participant connection itself remains online; losing the mic is not the same as being kicked out of Relay.

## Scope boundary

This model intentionally does not introduce:

- accounts, passwords, email or OAuth;
- persistent server-side user records;
- friends, chat or social profiles;
- host/admin roles;
- a microphone queue.

Those can be added only if a real product need appears. Presence + nickname + single mic ownership is the current domain boundary.
