import assert from 'node:assert/strict';
import test from 'node:test';

import { RelayClient, sleep, startRelay } from './helpers/harness.js';
import { micPublisher, playRoomSong, registerPlayback } from './support/client-commands.js';

const FAST = {
  RELAY_AUTO_CALIBRATE: '0',
};

type Relay = Awaited<ReturnType<typeof startRelay>>;
type Identity = { transportId: string; generation: number };

const A: Identity = { transportId: 'playback-tab-a', generation: 10 };

async function playback(server: Relay, identity: Identity) {
  const client = await RelayClient.connectAs(server, 'A');
  await registerPlayback(client, identity.transportId, identity.generation);
  return client;
}

test('a playback tab that comes back on a new socket is asked again for the command it owes', async () => {
  const server = await startRelay(FAST);
  try {
    const first = await playback(server, A);
    const mic = await micPublisher(server, 'A');
    await playRoomSong(first, { prefix: 'continuation' });

    first.send({ type: 'room-song-command', commandId: 'continuation-pause', expectedRevision: 2, action: 'pause' });
    await first.waitFor((message) => message.type === 'room-song-command-apply' && message.commandId === 'continuation-pause');

    // Same tab, same generation, new socket: what a WebSocket reconnect looks like.
    const again = await RelayClient.connectAs(server, 'A');
    await registerPlayback(again, A.transportId, A.generation);
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
