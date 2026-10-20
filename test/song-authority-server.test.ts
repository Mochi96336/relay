import assert from 'node:assert/strict';
import test from 'node:test';

import { participantIdFor, RelayClient, sleep, startRelay } from './helpers/harness.js';
import { loadRoomSong, registerPlayback } from './support/client-commands.js';
import { youtubeTelemetry } from './support/youtube-telemetry.js';

const VIDEO = 'dQw4w9WgXcQ';
const A_ID = participantIdFor('A');

function telemetry(currentTime: number, transportId = 'playback-transport-a', generation = 1, state = 1) {
  return {
    type: 'youtube-telemetry',
    ...youtubeTelemetry({
      state, currentTime, bufferedFraction: 0.5, playbackTransportId: transportId, playbackGeneration: generation,
    }),
  };
}

test('server keeps one authoritative participant playback transport', async () => {
  const server = await startRelay();
  try {
    const a = await RelayClient.connectAs(server, 'A');
    const b = await RelayClient.connectAs(server, 'B');

    await registerPlayback(a, 'playback-transport-a');
    await registerPlayback(b, 'playback-transport-b');
    await loadRoomSong(a, { positionSeconds: 10, commandId: 'authority-load-1' });

    a.send({ type: 'youtube-timeline-request' });
    const leader = await a.waitFor((message) => (
      message.type === 'youtube-timeline-status'
      && message.playbackLeaderParticipantId === A_ID
    ));
    assert.equal(leader.playbackTransportId, 'playback-transport-a');

    // Once 1A exists, a competing identified tab cannot even use telemetry as
    // a product mutation. The lower SongSession authority remains covered by
    // its focused domain tests; this server contract pins the layered result.
    b.send(telemetry(90, 'playback-transport-b'));
    const rejected = await b.waitFor((message) => message.type === 'room-song-telemetry-rejected');
    assert.equal(rejected.reason, 'command-required');

    b.send({ type: 'youtube-timeline-request' });
    await sleep(50);
    const status = b.latest('youtube-timeline-status');

    assert.ok(status);
    assert.equal(status.playbackLeaderParticipantId, A_ID);
    assert.equal(status.playbackTransportId, 'playback-transport-a');
    assert.ok(Number(status.serverTime) < 20, `competing telemetry overwrote timeline: ${status.serverTime}`);
  } finally {
    await server.stop();
  }
});

test('anonymous non-publisher sockets cannot claim the room timeline', async () => {
  const server = await startRelay();
  try {
    const anonymous = await RelayClient.connect(server);
    anonymous.send(telemetry(90, 'anonymous-playback'));
    await sleep(100);
    anonymous.send({ type: 'youtube-timeline-request' });
    await sleep(50);

    const status = anonymous.latest('youtube-timeline-status');
    assert.ok(status);
    assert.equal(status.videoId, undefined);
    assert.equal(status.playbackLeaderParticipantId, null);
  } finally {
    await server.stop();
  }
});

test('a rejected playback page is told why, once per reason', async () => {
  const server = await startRelay();
  try {
    const a = await RelayClient.connectAs(server, 'A');
    const b = await RelayClient.connectAs(server, 'B');

    // Room song changes go through the command path now, so establish one that
    // way before testing what a competing player is told.
    await registerPlayback(a, 'playback-transport-a');
    a.send({
      type: 'room-song-command',
      commandId: 'command-load-authority',
      expectedRevision: 0,
      action: 'load',
      videoId: VIDEO,
      positionSeconds: 10,
    });
    await a.waitFor((message) => (
      message.type === 'room-song-command-apply' && message.commandId === 'command-load-authority'
    ));
    a.send({ ...telemetry(10), state: 5 });
    await a.waitFor((message) => (
      message.type === 'youtube-timeline-status'
      && message.playbackLeaderParticipantId === A_ID
    ));

    // B reports the room's own position, so this is not an attempted mutation:
    // the command gate lets it through and playback authority is what refuses.
    b.send({ ...telemetry(10, 'playback-transport-b'), state: 5 });
    const rejected = await b.waitFor((message) => message.type === 'youtube-telemetry-rejected');
    assert.equal(rejected.reason, 'leader-busy');
    assert.equal(rejected.playbackLeaderParticipantId, A_ID);

    // Telemetry repeats several times a second; repeating the same rejection
    // would drown the socket in messages nobody can act on.
    const seen = b.messages.filter((message) => message.type === 'youtube-telemetry-rejected').length;
    b.send({ ...telemetry(10, 'playback-transport-b'), state: 5 });
    b.send({ ...telemetry(10, 'playback-transport-b'), state: 5 });
    await sleep(150);
    assert.equal(
      b.messages.filter((message) => message.type === 'youtube-telemetry-rejected').length,
      seen,
      'the same rejection reason was repeated',
    );
  } finally {
    await server.stop();
  }
});
