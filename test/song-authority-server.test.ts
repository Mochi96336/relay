import assert from 'node:assert/strict';
import test from 'node:test';

import { RelayClient, sleep, startRelay } from './helpers/harness.js';

const VIDEO = 'dQw4w9WgXcQ';

function telemetry(currentTime: number, transportId = 'playback-transport-a', generation = 1) {
  return {
    type: 'youtube-telemetry',
    videoId: VIDEO,
    state: 1,
    currentTime,
    duration: 200,
    playbackRate: 1,
    bufferedFraction: 0.5,
    playbackTransportId: transportId,
    playbackGeneration: generation,
  };
}

test('server keeps one authoritative participant playback transport', async () => {
  const server = await startRelay();
  try {
    const a = await RelayClient.connect(server, '?participant=participant-a&name=A');
    const b = await RelayClient.connect(server, '?participant=participant-b&name=B');

    a.send(telemetry(10));
    const leader = await a.waitFor((message) => (
      message.type === 'youtube-timeline-status'
      && message.playbackLeaderParticipantId === 'participant-a'
    ));
    assert.equal(leader.playbackTransportId, 'playback-transport-a');

    b.send(telemetry(90, 'playback-transport-b'));
    await sleep(100);
    b.send({ type: 'youtube-timeline-request' });
    const status = await b.waitFor((message) => (
      message.type === 'youtube-timeline-status'
      && message.playbackLeaderParticipantId === 'participant-a'
      && Number(message.serverTime) < 20
    ));

    assert.equal(status.playbackLeaderParticipantId, 'participant-a');
    assert.equal(status.playbackTransportId, 'playback-transport-a');
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

    const status = await anonymous.waitFor((message) => message.type === 'youtube-timeline-status');
    assert.equal(status.videoId, null);
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
    const after = await observer.waitFor((message) => (
      message.type === 'youtube-timeline-status'
      && message.playbackLeaderParticipantId === '__relay_legacy_publisher__'
      && Number(message.serverTime) < 20
    ));
    assert.equal(after.playbackLeaderParticipantId, '__relay_legacy_publisher__');
  } finally {
    await server.stop();
  }
});
