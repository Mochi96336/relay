import assert from 'node:assert/strict';
import test from 'node:test';

import { RelayClient, startRelay } from './helpers/harness.js';

const VIDEO = 'dQw4w9WgXcQ';

function telemetry(currentTime: number, state: number, transportId: string) {
  return {
    type: 'youtube-telemetry',
    videoId: VIDEO,
    state,
    currentTime,
    duration: 200,
    playbackRate: 1,
    bufferedFraction: 0.7,
    playbackTransportId: transportId,
    playbackGeneration: 1,
  };
}

async function registerPlayback(client: RelayClient, transportId: string) {
  client.send({
    type: 'playback-hello',
    playbackTransportId: transportId,
    playbackGeneration: 1,
  });
  await client.waitFor((message) => (
    message.type === 'playback-registered'
    && message.playbackTransportId === transportId
  ));
}

async function establishRoom(client: RelayClient, transportId: string) {
  client.send({
    type: 'room-song-command',
    commandId: 'command-load-base',
    expectedRevision: 0,
    action: 'load',
    videoId: VIDEO,
    positionSeconds: 0,
  });
  await client.waitFor((message) => (
    message.type === 'room-song-command-accepted'
    && message.commandId === 'command-load-base'
    && message.revision === 1
  ));
  await client.waitFor((message) => (
    message.type === 'room-song-command-apply'
    && message.commandId === 'command-load-base'
  ));
  client.send(telemetry(0, 5, transportId));
  await client.waitFor((message) => (
    message.type === 'room-song-command-complete'
    && message.commandId === 'command-load-base'
  ));
}

test('rapid play -> seek -> pause converges to the latest complete desired state', async () => {
  const server = await startRelay();
  try {
    const a = await RelayClient.connect(server, '?participant=participant-a&name=A');
    const transport = 'playback-latest-a';
    await registerPlayback(a, transport);
    await establishRoom(a, transport);

    a.send({
      type: 'room-song-command',
      commandId: 'command-play-fast',
      expectedRevision: 1,
      action: 'play',
    });
    const playAccepted = await a.waitFor((message) => (
      message.type === 'room-song-command-accepted'
      && message.commandId === 'command-play-fast'
    ));
    assert.equal(playAccepted.revision, 2);
    const playApply = await a.waitFor((message) => (
      message.type === 'room-song-command-apply'
      && message.commandId === 'command-play-fast'
    ));
    assert.equal(playApply.desired.state, 1);

    // Deliberately keep the revision observed before command-play-fast. The
    // explicit predecessor proves this is a causal successor, not an arbitrary
    // stale write.
    a.send({
      type: 'room-song-command',
      commandId: 'command-seek-fast',
      expectedRevision: 1,
      supersedesCommandId: 'command-play-fast',
      action: 'seek',
      positionSeconds: 40,
    });
    const seekAccepted = await a.waitFor((message) => (
      message.type === 'room-song-command-accepted'
      && message.commandId === 'command-seek-fast'
    ));
    assert.equal(seekAccepted.revision, 3);
    const seekApply = await a.waitFor((message) => (
      message.type === 'room-song-command-apply'
      && message.commandId === 'command-seek-fast'
    ));
    assert.equal(seekApply.desired.videoId, VIDEO);
    assert.equal(seekApply.desired.state, 1);
    assert.ok(Math.abs(Number(seekApply.desired.positionSeconds) - 40) < 0.5);

    a.send({
      type: 'room-song-command',
      commandId: 'command-pause-fast',
      expectedRevision: 1,
      supersedesCommandId: 'command-seek-fast',
      action: 'pause',
    });
    const pauseAccepted = await a.waitFor((message) => (
      message.type === 'room-song-command-accepted'
      && message.commandId === 'command-pause-fast'
    ));
    assert.equal(pauseAccepted.revision, 4);
    const pauseApply = await a.waitFor((message) => (
      message.type === 'room-song-command-apply'
      && message.commandId === 'command-pause-fast'
    ));
    assert.equal(pauseApply.desired.state, 2);
    assert.ok(Math.abs(Number(pauseApply.desired.positionSeconds) - 40) < 0.5);

    // A late proof for the superseded play/old room position is not allowed to
    // complete command-pause-fast.
    a.send(telemetry(0.2, 1, transport));
    const late = await a.waitFor((message) => message.type === 'room-song-telemetry-rejected');
    assert.equal(late.reason, 'command-mismatch');

    a.send(telemetry(Number(pauseApply.desired.positionSeconds), 2, transport));
    await a.waitFor((message) => (
      message.type === 'room-song-command-complete'
      && message.commandId === 'command-pause-fast'
      && message.revision === 4
    ));

    a.send({ type: 'room-song-command-status-request' });
    const status = await a.waitFor((message) => (
      message.type === 'room-song-command-status'
      && message.revision === 4
      && message.pendingCommandId === null
    ));
    assert.equal(status.pendingAction, null);
  } finally {
    await server.stop();
  }
});
