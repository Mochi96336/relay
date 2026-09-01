import assert from 'node:assert/strict';
import test from 'node:test';

import { createRelayInfrastructureEventProtocol } from '../src/relay-infrastructure-event-protocol.js';

test('infrastructure event protocol selects observations and preserves payload identity', () => {
  const socket = { id: 'infra-a' };
  const seen: Array<{ handler: string; socket: typeof socket; payload: Record<string, unknown> }> = [];
  const protocol = createRelayInfrastructureEventProtocol<typeof socket>({
    backingSampleBoundary: (nextSocket, payload) => seen.push({ handler: 'backing-sample-boundary', socket: nextSocket, payload }),
    robotPlayerOffset: (nextSocket, payload) => seen.push({ handler: 'robot-player-offset', socket: nextSocket, payload }),
    calibrationProbe: (nextSocket, payload) => seen.push({ handler: String(payload.type), socket: nextSocket, payload }),
    sourceSeeked: (nextSocket, payload) => seen.push({ handler: 'source-seeked', socket: nextSocket, payload }),
  });

  const boundary = { type: 'backing-sample-boundary', requestId: 4, generation: 2, firstSampleIndex: 960 };
  const offset = { type: 'robot-player-offset', offsetMs: -42 };
  const probePlayed = { type: 'calibration-probe-played', target: 'mic', requestId: 7, generation: 3 };
  const probeFailed = { type: 'calibration-probe-failed', target: 'backing', requestId: 8, reason: 'playback-failed' };
  const seeked = { type: 'source-seeked', reason: 'follower-correction', fromMediaTime: 12, toMediaTime: 14 };

  assert.equal(protocol.dispatch(socket, boundary), true);
  assert.equal(protocol.dispatch(socket, offset), true);
  assert.equal(protocol.dispatch(socket, probePlayed), true);
  assert.equal(protocol.dispatch(socket, probeFailed), true);
  assert.equal(protocol.dispatch(socket, seeked), true);
  assert.deepEqual(seen.map((entry) => entry.handler), [
    'backing-sample-boundary',
    'robot-player-offset',
    'calibration-probe-played',
    'calibration-probe-failed',
    'source-seeked',
  ]);
  assert.equal(seen[0]?.socket, socket);
  assert.equal(seen[0]?.payload, boundary);
  assert.equal(seen[1]?.payload, offset);
  assert.equal(seen[2]?.payload, probePlayed);
  assert.equal(seen[3]?.payload, probeFailed);
  assert.equal(seen[4]?.payload, seeked);
});

test('infrastructure event protocol leaves authentication, registration, lifecycle, and malformed messages to later routing', () => {
  let calls = 0;
  const protocol = createRelayInfrastructureEventProtocol<object>({
    backingSampleBoundary: () => { calls += 1; },
    robotPlayerOffset: () => { calls += 1; },
    calibrationProbe: () => { calls += 1; },
    sourceSeeked: () => { calls += 1; },
  });

  assert.equal(protocol.dispatch({}, { type: 'infrastructure-authenticate' }), false);
  assert.equal(protocol.dispatch({}, { type: 'register', role: 'backing' }), false);
  assert.equal(protocol.dispatch({}, { type: 'robot-source-hello' }), false);
  assert.equal(protocol.dispatch({}, {}), false);
  assert.equal(calls, 0);
});
