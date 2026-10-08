import assert from 'node:assert/strict';
import test from 'node:test';

import { RelayClient, sleep, startRelay, waitForNewMessage } from './helpers/harness.js';

const RATE = 48_000;
const VIDEO = 'dQw4w9WgXcQ';
const FAST = {
  RELAY_AUTO_CALIBRATE: '0',
  RELAY_HEARTBEAT_MS: '60000',
};

type Relay = Awaited<ReturnType<typeof startRelay>>;
type Identity = { participantId: string; transportId: string; generation: number };

const A: Identity = { participantId: 'participant-a', transportId: 'playback-tab-a', generation: 10 };

function telemetry(currentTime: number, state = 1) {
  return {
    type: 'youtube-telemetry',
    videoId: VIDEO,
    state,
    currentTime,
    duration: 200,
    playbackRate: 1,
    bufferedFraction: 0.8,
  };
}

async function playback(server: Relay, identity: Identity) {
  const client = await RelayClient.connect(server, `?participant=${identity.participantId}&name=A`);
  client.send({
    type: 'playback-hello',
    playbackTransportId: identity.transportId,
    playbackGeneration: identity.generation,
  });
  await client.waitForType('playback-registered');
  return client;
}

async function publisher(server: Relay, participantId: string) {
  const client = await RelayClient.connect(server, `?participant=${participantId}&name=A`);
  client.send({ type: 'register', role: 'publisher', sampleRate: RATE, captureGeneration: 1 });
  await client.waitFor((message) => message.type === 'registered' && message.role === 'publisher');
  return client;
}

async function playingRoom(client: RelayClient) {
  client.send({
    type: 'room-song-command', commandId: 'continuation-load', expectedRevision: 0,
    action: 'load', videoId: VIDEO, positionSeconds: 10,
  });
  await client.waitFor((message) => message.type === 'room-song-command-apply' && message.commandId === 'continuation-load');
  client.send(telemetry(10, 5));
  await client.waitFor((message) => message.type === 'room-song-command-complete' && message.commandId === 'continuation-load');
  client.send({ type: 'room-song-command', commandId: 'continuation-play', expectedRevision: 1, action: 'play' });
  await client.waitFor((message) => message.type === 'room-song-command-apply' && message.commandId === 'continuation-play');
  client.send(telemetry(10.05));
  await client.waitFor((message) => message.type === 'room-song-command-complete' && message.commandId === 'continuation-play');
}

test('a playback tab that comes back on a new socket is asked again for the command it owes', async () => {
  const server = await startRelay(FAST);
  try {
    const first = await playback(server, A);
    const mic = await publisher(server, A.participantId);
    await playingRoom(first);

    first.send({ type: 'room-song-command', commandId: 'continuation-pause', expectedRevision: 2, action: 'pause' });
    await first.waitFor((message) => message.type === 'room-song-command-apply' && message.commandId === 'continuation-pause');

    // Same tab, same generation, new socket: what a WebSocket reconnect looks like.
    const again = await RelayClient.connect(server, `?participant=${A.participantId}&name=A`);
    again.send({
      type: 'playback-hello',
      playbackTransportId: A.transportId,
      playbackGeneration: A.generation,
    });
    await again.waitForType('playback-registered');
    const status = await again.waitFor((message) => message.type === 'room-song-command-status', 1_000);
    assert.equal(status.pendingCommandId, 'continuation-pause');
    const apply = await again.waitFor((message) => (
      message.type === 'room-song-command-apply' && message.commandId === 'continuation-pause'
    ), 1_000);
    assert.equal(apply.action, 'pause');

    mic.close();
  } finally {
    await server.stop();
  }
});

test('a song handoff answer for a handoff that does not exist changes nothing', async () => {
  const server = await startRelay(FAST);
  try {
    const tab = await playback(server, A);
    const from = tab.messages.length;
    tab.send({ type: 'song-handoff-ready', handoffId: 'no-such-handoff' });
    tab.send({ type: 'song-handoff-failed', handoffId: 'no-such-handoff' });
    await sleep(200);

    assert.equal(
      tab.messages.slice(from).some((message) => String(message.type).startsWith('song-handoff-')),
      false,
    );
    const response = await fetch(server.httpUrl('/statusz'));
    assert.equal(response.status, 200, 'the Relay is still up');
  } finally {
    await server.stop();
  }
});
