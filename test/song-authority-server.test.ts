import assert from 'node:assert/strict';
import test from 'node:test';

import { RelayClient, sleep, startRelay } from './helpers/harness.js';

const VIDEO = 'dQw4w9WgXcQ';

function telemetry(currentTime: number, transportId = 'playback-transport-a', generation = 1, state = 1) {
  return {
    type: 'youtube-telemetry',
    videoId: VIDEO,
    state,
    currentTime,
    duration: 200,
    playbackRate: 1,
    bufferedFraction: 0.5,
    playbackTransportId: transportId,
    playbackGeneration: generation,
  };
}

async function registerPlayback(client: RelayClient, transportId: string, generation = 1) {
  client.send({
    type: 'playback-hello',
    playbackTransportId: transportId,
    playbackGeneration: generation,
  });
  await client.waitFor((message) => (
    message.type === 'playback-registered'
    && message.playbackTransportId === transportId
    && message.playbackGeneration === generation
  ));
}

async function establishRoomSong(client: RelayClient, transportId: string, currentTime: number) {
  client.send({
    type: 'room-song-command',
    commandId: 'authority-load-1',
    expectedRevision: 0,
    action: 'load',
    videoId: VIDEO,
    positionSeconds: currentTime,
  });
  await client.waitFor((message) => (
    message.type === 'room-song-command-accepted'
    && message.commandId === 'authority-load-1'
  ));
  await client.waitFor((message) => (
    message.type === 'room-song-command-apply'
    && message.commandId === 'authority-load-1'
  ));
  client.send(telemetry(currentTime, transportId, 1, 5));
  await client.waitFor((message) => (
    message.type === 'room-song-command-complete'
    && message.commandId === 'authority-load-1'
  ));
}

test('server keeps one authoritative participant playback transport', async () => {
  const server = await startRelay();
  try {
    const a = await RelayClient.connect(server, '?participant=participant-a&name=A');
    const b = await RelayClient.connect(server, '?participant=participant-b&name=B');

    await registerPlayback(a, 'playback-transport-a');
    await registerPlayback(b, 'playback-transport-b');
    await establishRoomSong(a, 'playback-transport-a', 10);

    a.send({ type: 'youtube-timeline-request' });
    const leader = await a.waitFor((message) => (
      message.type === 'youtube-timeline-status'
      && message.playbackLeaderParticipantId === 'participant-a'
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
    assert.equal(status.playbackLeaderParticipantId, 'participant-a');
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

test('only the selected anonymous publisher keeps the narrow legacy telemetry path', async () => {
  const server = await startRelay();
  try {
    const publisher = await RelayClient.connect(server);
    const observer = await RelayClient.connect(server);

    publisher.send({ type: 'register', role: 'publisher', sampleRate: 48_000, captureGeneration: 7 });
    await publisher.waitFor((message) => message.type === 'registered' && message.role === 'publisher');

    // Legacy publisher clients did not carry participant/playback fields.
    publisher.send({
      type: 'youtube-telemetry',
      videoId: VIDEO,
      state: 1,
      currentTime: 12,
      duration: 200,
      playbackRate: 1,
      bufferedFraction: 0.5,
    });

    const accepted = await observer.waitFor((message) => (
      message.type === 'youtube-timeline-status'
      && message.videoId === VIDEO
    ));
    assert.equal(accepted.playbackLeaderParticipantId, '__relay_legacy_publisher__');

    observer.send(telemetry(90, 'anonymous-observer'));
    await sleep(100);
    observer.send({ type: 'youtube-timeline-request' });
    await sleep(50);
    const after = observer.latest('youtube-timeline-status');

    assert.ok(after);
    assert.equal(after.playbackLeaderParticipantId, '__relay_legacy_publisher__');
    assert.ok(Number(after.serverTime) < 20, `anonymous observer overwrote timeline: ${after.serverTime}`);
  } finally {
    await server.stop();
  }
});

test('a rejected playback page is told why, once per reason', async () => {
  const server = await startRelay();
  try {
    const a = await RelayClient.connect(server, '?participant=participant-a&name=A');
    const b = await RelayClient.connect(server, '?participant=participant-b&name=B');

    a.send(telemetry(10));
    await a.waitFor((message) => (
      message.type === 'youtube-timeline-status'
      && message.playbackLeaderParticipantId === 'participant-a'
    ));

    b.send(telemetry(90, 'playback-transport-b'));
    const rejected = await b.waitFor((message) => message.type === 'youtube-telemetry-rejected');
    assert.equal(rejected.reason, 'leader-busy');
    assert.equal(rejected.playbackLeaderParticipantId, 'participant-a');

    // Telemetry repeats several times a second; repeating the same rejection
    // would drown the socket in messages nobody can act on.
    const seen = b.messages.filter((message) => message.type === 'youtube-telemetry-rejected').length;
    b.send(telemetry(91, 'playback-transport-b'));
    b.send(telemetry(92, 'playback-transport-b'));
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

test('a replacement anonymous publisher takes the room clock without waiting out the old one', async () => {
  const server = await startRelay();
  try {
    const observer = await RelayClient.connect(server);
    const first = await RelayClient.connect(server);
    first.send({ type: 'register', role: 'publisher', sampleRate: 48_000 });
    await first.waitFor((message) => message.type === 'registered' && message.role === 'publisher');

    const legacyTelemetry = (currentTime: number) => ({
      type: 'youtube-telemetry',
      videoId: VIDEO,
      state: 1,
      currentTime,
      duration: 200,
      playbackRate: 1,
      bufferedFraction: 0.5,
    });

    first.send(legacyTelemetry(12));
    await observer.waitFor((message) => (
      message.type === 'youtube-timeline-status' && message.videoId === VIDEO
    ));

    // The replacement is the same anonymous playback device reconnecting, so it
    // must not have to wait out the previous socket's staleness window.
    const second = await RelayClient.connect(server);
    second.send({ type: 'register', role: 'publisher', sampleRate: 48_000 });
    await second.waitFor((message) => message.type === 'registered' && message.role === 'publisher');

    second.send(legacyTelemetry(120));
    const moved = await observer.waitFor(
      (message) => message.type === 'youtube-timeline-status' && Number(message.serverTime) > 100,
      1_000,
    );
    assert.equal(moved.playbackLeaderParticipantId, '__relay_legacy_publisher__');
  } finally {
    await server.stop();
  }
});
