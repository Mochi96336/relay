import assert from 'node:assert/strict';
import test from 'node:test';

import { createRelayAuthenticationProtocol } from '../src/relay-authentication-protocol.js';

test('authentication protocol selects auth messages and preserves payload identity', () => {
  const socket = { id: 'auth-a' };
  const seen: Array<{ handler: string; socket: typeof socket; payload: Record<string, unknown> }> = [];
  const protocol = createRelayAuthenticationProtocol<typeof socket>({
    infrastructureAuthenticate: (nextSocket, payload) => seen.push({ handler: 'infrastructure-authenticate', socket: nextSocket, payload }),
    participantAuthenticate: (nextSocket, payload) => seen.push({ handler: 'participant-authenticate', socket: nextSocket, payload }),
  });

  const infrastructure = { type: 'infrastructure-authenticate', key: 'secret' };
  const participant = { type: 'participant-authenticate', participantId: 'participant-a', capability: 'capability-a' };

  assert.equal(protocol.dispatch(socket, infrastructure), true);
  assert.equal(protocol.dispatch(socket, participant), true);
  assert.deepEqual(seen.map((entry) => entry.handler), [
    'infrastructure-authenticate',
    'participant-authenticate',
  ]);
  assert.equal(seen[0]?.socket, socket);
  assert.equal(seen[0]?.payload, infrastructure);
  assert.equal(seen[1]?.payload, participant);
});

test('authentication protocol leaves registration, infrastructure observations, lifecycle, and malformed messages to later routing', () => {
  let calls = 0;
  const protocol = createRelayAuthenticationProtocol<object>({
    infrastructureAuthenticate: () => { calls += 1; },
    participantAuthenticate: () => { calls += 1; },
  });

  assert.equal(protocol.dispatch({}, { type: 'register', role: 'publisher' }), false);
  assert.equal(protocol.dispatch({}, { type: 'source-seeked' }), false);
  assert.equal(protocol.dispatch({}, { type: 'robot-source-hello' }), false);
  assert.equal(protocol.dispatch({}, {}), false);
  assert.equal(calls, 0);
});
