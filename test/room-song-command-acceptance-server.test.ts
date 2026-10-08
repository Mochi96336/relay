import assert from 'node:assert/strict';
import test from 'node:test';

import { RelayClient, sleep, startRelay, waitForNewMessage } from './helpers/harness.js';

const VIDEO = 'dQw4w9WgXcQ';
const FAST = { RELAY_AUTO_CALIBRATE: '0', RELAY_HEARTBEAT_MS: '60000' };

async function playbackTab(server: Awaited<ReturnType<typeof startRelay>>) {
  const tab = await RelayClient.connect(server, '?participant=participant-a&name=A');
  tab.send({ type: 'playback-hello', playbackTransportId: 'acceptance-tab', playbackGeneration: 1 });
  await tab.waitForType('playback-registered');
  return tab;
}

const load = {
  type: 'room-song-command',
  commandId: 'acceptance-load',
  expectedRevision: 0,
  action: 'load',
  videoId: VIDEO,
  positionSeconds: 10,
};

test('an accepted room command is published as pending, and applied by the tab it targets', async () => {
  const server = await startRelay(FAST);
  try {
    const watcher = await RelayClient.connect(server, '?participant=participant-w&name=W');
    const tab = await playbackTab(server);

    const from = watcher.messages.length;
    tab.send(load);
    const accepted = await tab.waitFor((message) => (
      message.type === 'room-song-command-accepted' && message.commandId === 'acceptance-load'
    ));
    assert.equal(accepted.duplicate, false);
    await tab.waitFor((message) => message.type === 'room-song-command-apply' && message.commandId === 'acceptance-load');
    await waitForNewMessage(watcher, from, (message) => (
      message.type === 'room-song-command-status' && message.pendingCommandId === 'acceptance-load'
    ), 1_000);
  } finally {
    await server.stop();
  }
});

test('a room command sent again after it completed is acknowledged as a duplicate and not applied again', async () => {
  const server = await startRelay(FAST);
  try {
    const tab = await playbackTab(server);
    tab.send(load);
    await tab.waitFor((message) => message.type === 'room-song-command-apply' && message.commandId === 'acceptance-load');
    tab.send({
      type: 'youtube-telemetry', videoId: VIDEO, state: 5, currentTime: 10,
      duration: 200, playbackRate: 1, bufferedFraction: 0.8,
    });
    await tab.waitFor((message) => message.type === 'room-song-command-complete' && message.commandId === 'acceptance-load');

    const from = tab.messages.length;
    tab.send(load);
    const again = await waitForNewMessage(tab, from, (message) => (
      message.type === 'room-song-command-accepted' || message.type === 'room-song-command-rejected'
    ));
    assert.equal(again.type, 'room-song-command-accepted', JSON.stringify(again));
    assert.equal(again.duplicate, true);
    await sleep(300);
    assert.equal(
      tab.messages.slice(from).some((message) => message.type === 'room-song-command-apply'),
      false,
      'a command that already completed is not applied twice',
    );
  } finally {
    await server.stop();
  }
});
