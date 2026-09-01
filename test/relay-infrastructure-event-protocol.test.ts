import assert from 'node:assert/strict';
import test from 'node:test';

import { createRelayInfrastructureEventProtocol } from '../src/relay-infrastructure-event-protocol.js';

test('infrastructure event protocol selects observations and preserves payload identity', () => {
  const socket = { id: 'infra-a' };
  const seen: Array<{ handler: string; socket: typeof socket; payload: Record<string, unknown> }> = [];
  const protocol = createRelayInfrastructureEventProtocol<typeof socket>({
    backingSampleBoundary: (nextSocket, payload) => seen.push({ handler: 'backing-sample-boundary', socket: nextSocket, payload }),
    robotPlayerOffset: (nextSocket, payload) => seen.push({ handler: 'robot-player-offset', socket: nextSocket, payload }),
  });

  const boundary = { type: 'backing-sample-boundary', requestId: 4, generation: 2, firstSampleIndex: 960 };
  const offset = { type: 'robot-player-offset', offsetMs: -42 };

  assert.equal(protocol.dispatch(socket, boundary), true);
  assert.equal(protocol.dispatch(socket, offset), true);
  assert.deepEqual(seen.map((entry) => entry.handler), ['backing-sample-boundary', 'robot-player-offset']);
  assert.equal(seen[0]?.socket, socket);
  assert.equal(seen[0]?.payload, boundary);
  assert.equal(seen[1]?.payload, offset);
});

test('infrastructure event protocol leaves authentication, lifecycle, and malformed messages to later routing', () => {
  let calls = 0;
  const protocol = createRelayInfrastructureEventProtocol<object>({
    backingSampleBoundary: () => { calls += 1; },
    robotPlayerOffset: () => { calls += 1; },
  });

  assert.equal(protocol.dispatch({}, { type: 'infrastructure-authenticate' }), false);
  assert.equal(protocol.dispatch({}, { type: 'robot-source-hello' }), false);
  assert.equal(protocol.dispatch({}, { type: 'source-seeked' }), false);
  assert.equal(protocol.dispatch({}, {}), false);
  assert.equal(calls, 0);
});
