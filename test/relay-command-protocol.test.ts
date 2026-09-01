import assert from 'node:assert/strict';
import test from 'node:test';

import { createRelayCommandProtocol } from '../src/relay-command-protocol.js';

test('command protocol selects the extracted low-risk commands and preserves payload identity', () => {
  const socket = { id: 'socket-a' };
  const seen: Array<{ handler: string; socket: typeof socket; payload: Record<string, unknown> }> = [];
  const protocol = createRelayCommandProtocol<typeof socket>({
    startTake: (nextSocket, payload) => seen.push({ handler: 'start-take', socket: nextSocket, payload }),
    stopTake: (nextSocket, payload) => seen.push({ handler: 'stop-take', socket: nextSocket, payload }),
    releaseMic: (nextSocket, payload) => seen.push({ handler: 'release-mic', socket: nextSocket, payload }),
    roomSongCommand: (nextSocket, payload) => seen.push({ handler: 'room-song-command', socket: nextSocket, payload }),
    roomSongCommandFailed: (nextSocket, payload) => seen.push({ handler: 'room-song-command-failed', socket: nextSocket, payload }),
    songHandoffReady: (nextSocket, payload) => seen.push({ handler: 'song-handoff-ready', socket: nextSocket, payload }),
    songHandoffFailed: (nextSocket, payload) => seen.push({ handler: 'song-handoff-failed', socket: nextSocket, payload }),
    participantRename: (nextSocket, payload) => seen.push({ handler: 'rename', socket: nextSocket, payload }),
    rejectMicReservation: (nextSocket, payload) => seen.push({ handler: 'mic-reservation', socket: nextSocket, payload }),
    playbackMicIntent: (nextSocket, payload) => seen.push({ handler: 'playback-intent', socket: nextSocket, payload }),
    playbackHello: (nextSocket, payload) => seen.push({ handler: 'playback-hello', socket: nextSocket, payload }),
    youtubeTelemetry: (nextSocket, payload) => seen.push({ handler: 'youtube-telemetry', socket: nextSocket, payload }),
  });

  const startTake = { type: 'start-take' };
  const stopTake = { type: 'stop-take', takeId: 'take-a' };
  const releaseMic = { type: 'release-mic' };
  const roomSongCommand = { type: 'room-song-command', commandId: 'command-a' };
  const roomSongCommandFailed = { type: 'room-song-command-failed', commandId: 'command-a' };
  const songHandoffReady = { type: 'song-handoff-ready', handoffId: 'handoff-a' };
  const songHandoffFailed = { type: 'song-handoff-failed', handoffId: 'handoff-a' };
  const rename = { type: 'participant-rename', nickname: 'Mochi' };
  const acquire = { type: 'acquire-mic' };
  const forceAcquire = { type: 'force-acquire-mic' };
  const intent = { type: 'playback-mic-intent' };
  const hello = { type: 'playback-hello', playbackTransportId: 'playback-tab-a', playbackGeneration: 2 };
  const telemetry = { type: 'youtube-telemetry', playbackTransportId: 'playback-tab-a', playbackGeneration: 2 };

  assert.equal(protocol.dispatch(socket, startTake), true);
  assert.equal(protocol.dispatch(socket, stopTake), true);
  assert.equal(protocol.dispatch(socket, releaseMic), true);
  assert.equal(protocol.dispatch(socket, roomSongCommand), true);
  assert.equal(protocol.dispatch(socket, roomSongCommandFailed), true);
  assert.equal(protocol.dispatch(socket, songHandoffReady), true);
  assert.equal(protocol.dispatch(socket, songHandoffFailed), true);
  assert.equal(protocol.dispatch(socket, rename), true);
  assert.equal(protocol.dispatch(socket, acquire), true);
  assert.equal(protocol.dispatch(socket, forceAcquire), true);
  assert.equal(protocol.dispatch(socket, intent), true);
  assert.equal(protocol.dispatch(socket, hello), true);
  assert.equal(protocol.dispatch(socket, telemetry), true);

  assert.deepEqual(seen.map((entry) => entry.handler), [
    'start-take',
    'stop-take',
    'release-mic',
    'room-song-command',
    'room-song-command-failed',
    'song-handoff-ready',
    'song-handoff-failed',
    'rename',
    'mic-reservation',
    'mic-reservation',
    'playback-intent',
    'playback-hello',
    'youtube-telemetry',
  ]);
  assert.equal(seen[0]?.socket, socket);
  assert.equal(seen[0]?.payload, startTake);
  assert.equal(seen[1]?.payload, stopTake);
  assert.equal(seen[2]?.payload, releaseMic);
  assert.equal(seen[3]?.payload, roomSongCommand);
  assert.equal(seen[4]?.payload, roomSongCommandFailed);
  assert.equal(seen[5]?.payload, songHandoffReady);
  assert.equal(seen[6]?.payload, songHandoffFailed);
  assert.equal(seen[7]?.payload, rename);
  assert.equal(seen[8]?.payload, acquire);
  assert.equal(seen[9]?.payload, forceAcquire);
  assert.equal(seen[10]?.payload, intent);
  assert.equal(seen[11]?.payload, hello);
  assert.equal(seen[12]?.payload, telemetry);
});

test('command protocol leaves unextracted commands and malformed envelopes to later routing', () => {
  let calls = 0;
  const protocol = createRelayCommandProtocol<object>({
    startTake: () => { calls += 1; },
    stopTake: () => { calls += 1; },
    releaseMic: () => { calls += 1; },
    roomSongCommand: () => { calls += 1; },
    roomSongCommandFailed: () => { calls += 1; },
    songHandoffReady: () => { calls += 1; },
    songHandoffFailed: () => { calls += 1; },
    participantRename: () => { calls += 1; },
    rejectMicReservation: () => { calls += 1; },
    playbackMicIntent: () => { calls += 1; },
    playbackHello: () => { calls += 1; },
    youtubeTelemetry: () => { calls += 1; },
  });

  assert.equal(protocol.dispatch({}, { type: 'robot-source-hello' }), false);
  assert.equal(protocol.dispatch({}, {}), false);
  assert.equal(calls, 0);
});
