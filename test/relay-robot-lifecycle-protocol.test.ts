import assert from 'node:assert/strict';
import test from 'node:test';

import { createRelayRobotLifecycleProtocol } from '../src/relay-robot-lifecycle-protocol.js';

test('dispatches Robot source hello with socket and payload identity intact', () => {
  const socket = { id: 'robot' };
  const payload = { type: 'robot-source-hello', marker: 7 };
  let seenSocket: unknown;
  let seenPayload: unknown;
  const protocol = createRelayRobotLifecycleProtocol({
    robotSourceHello: (nextSocket, nextPayload) => {
      seenSocket = nextSocket;
      seenPayload = nextPayload;
    },
  });

  assert.equal(protocol.dispatch(socket, payload), true);
  assert.equal(seenSocket, socket);
  assert.equal(seenPayload, payload);
});

test('leaves non-Robot lifecycle messages unhandled', () => {
  let calls = 0;
  const protocol = createRelayRobotLifecycleProtocol({
    robotSourceHello: () => { calls += 1; },
  });

  assert.equal(protocol.dispatch({}, { type: 'register', role: 'backing' }), false);
  assert.equal(protocol.dispatch({}, { type: 'source-seeked' }), false);
  assert.equal(protocol.dispatch({}, { type: 'infrastructure-authenticate' }), false);
  assert.equal(protocol.dispatch({}, {}), false);
  assert.equal(calls, 0);
});
