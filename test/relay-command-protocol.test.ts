import assert from 'node:assert/strict';
import test from 'node:test';

import { createRelayCommandProtocol } from '../src/relay-command-protocol.js';

test('command protocol selects the extracted low-risk commands and preserves payload identity', () => {
  const socket = { id: 'socket-a' };
  const seen: Array<{ handler: string; socket: typeof socket; payload: Record<string, unknown> }> = [];
  const protocol = createRelayCommandProtocol<typeof socket>({
    startTake: (nextSocket, payload) => seen.push({ handler: 'start-take', socket: nextSocket, payload }),
    stopTake: (nextSocket, payload) => seen.push({ handler: 'stop-take', socket: nextSocket, payload }),
    participantRename: (nextSocket, payload) => seen.push({ handler: 'rename', socket: nextSocket, payload }),
    rejectMicReservation: (nextSocket, payload) => seen.push({ handler: 'mic-reservation', socket: nextSocket, payload }),
    playbackMicIntent: (nextSocket, payload) => seen.push({ handler: 'playback-intent', socket: nextSocket, payload }),
  });

  const startTake = { type: 'start-take' };
  const stopTake = { type: 'stop-take', takeId: 'take-a' };
  const rename = { type: 'participant-rename', nickname: 'Mochi' };
  const acquire = { type: 'acquire-mic' };
  const forceAcquire = { type: 'force-acquire-mic' };
  const intent = { type: 'playback-mic-intent' };

  assert.equal(protocol.dispatch(socket, startTake), true);
  assert.equal(protocol.dispatch(socket, stopTake), true);
  assert.equal(protocol.dispatch(socket, rename), true);
  assert.equal(protocol.dispatch(socket, acquire), true);
  assert.equal(protocol.dispatch(socket, forceAcquire), true);
  assert.equal(protocol.dispatch(socket, intent), true);

  assert.deepEqual(seen.map((entry) => entry.handler), [
    'start-take',
    'stop-take',
    'rename',
    'mic-reservation',
    'mic-reservation',
    'playback-intent',
  ]);
  assert.equal(seen[0]?.socket, socket);
  assert.equal(seen[0]?.payload, startTake);
  assert.equal(seen[1]?.payload, stopTake);
  assert.equal(seen[2]?.payload, rename);
  assert.equal(seen[3]?.payload, acquire);
  assert.equal(seen[4]?.payload, forceAcquire);
  assert.equal(seen[5]?.payload, intent);
});

test('command protocol leaves unextracted commands and malformed envelopes to later routing', () => {
  let calls = 0;
  const protocol = createRelayCommandProtocol<object>({
    startTake: () => { calls += 1; },
    stopTake: () => { calls += 1; },
    participantRename: () => { calls += 1; },
    rejectMicReservation: () => { calls += 1; },
    playbackMicIntent: () => { calls += 1; },
  });

  assert.equal(protocol.dispatch({}, { type: 'release-mic' }), false);
  assert.equal(protocol.dispatch({}, { type: 'room-song-command' }), false);
  assert.equal(protocol.dispatch({}, { type: 'robot-source-hello' }), false);
  assert.equal(protocol.dispatch({}, {}), false);
  assert.equal(calls, 0);
});
