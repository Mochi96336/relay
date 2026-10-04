import assert from 'node:assert/strict';
import test from 'node:test';

import { RelayClient, sleep, startRelay, waitForNewMessage, type RelayServer } from './helpers/harness.js';

const VIDEO = 'nqooEdrsPoo';
const FAST = {
  RELAY_HEARTBEAT_MS: '60000',
  RELAY_AUTO_CALIBRATE: '0',
  RELAY_CALIBRATION_PROBE: '0',
};

function telemetry(state: number, currentTime: number, duration: number) {
  return {
    type: 'youtube-telemetry',
    videoId: VIDEO,
    state,
    currentTime,
    duration,
    playbackRate: 1,
    networkRttMs: 40,
  };
}

/** A phone that holds playback of VIDEO, loaded and, if asked, playing. */
async function holder(server: RelayServer, duration: number, play: boolean) {
  const phone = await RelayClient.connect(server, '?participant=song-holder-123&name=Holder');
  phone.send({ type: 'playback-hello', playbackTransportId: 'holder-playback', playbackGeneration: 1 });
  await phone.waitFor((message) => message.type === 'playback-registered');

  phone.send({
    type: 'room-song-command',
    commandId: 'load-song',
    expectedRevision: 0,
    action: 'load',
    videoId: VIDEO,
    positionSeconds: 0,
  });
  await phone.waitFor((message) => message.type === 'room-song-command-apply' && message.commandId === 'load-song');
  phone.send(telemetry(5, 0, duration));
  await phone.waitFor((message) => message.type === 'room-song-command-complete' && message.commandId === 'load-song');
  if (!play) return phone;

  phone.send({ type: 'room-song-command', commandId: 'play-song', expectedRevision: 1, action: 'play' });
  await phone.waitFor((message) => message.type === 'room-song-command-apply' && message.commandId === 'play-song');
  phone.send(telemetry(1, 0, duration));
  await phone.waitFor((message) => message.type === 'room-song-command-complete' && message.commandId === 'play-song');
  return phone;
}

async function productStatus(client: RelayClient) {
  const from = client.messages.length;
  client.send({ type: 'product-status-request' });
  return waitForNewMessage(client, from, (message) => message.type === 'product-status', 8_000);
}

test('a Song whose holder leaves stops at its end instead of playing on forever', async () => {
  const server = await startRelay(FAST);
  try {
    const watcher = await RelayClient.connect(server, '?participant=song-watcher-123&name=Watcher');
    const phone = await holder(server, 2, true);
    phone.close();

    // Two seconds of Song, then its end, then a little margin for staleness.
    await sleep(3_500);
    const from = watcher.messages.length;
    const room = await waitForNewMessage(watcher, from, (message) => message.type === 'room-song-status', 2_000);
    assert.equal(room.state, 0, 'the room must call the Song ended');
    assert.ok(room.serverTime <= 2, `the clock read ${room.serverTime} s of a 2 s Song`);

    const status = await productStatus(watcher);
    assert.equal(status.room.song.state, 'ready');
    assert.ok(
      !status.issues.some((issue: any) => issue.code === 'song-clock-unavailable'),
      'an ended Song has no clock to lose',
    );
    watcher.close();
  } finally {
    await server.stop();
  }
});

test("a video the Robot cannot play is named in product status until it plays again", async () => {
  const server = await startRelay(FAST);
  try {
    const robot = await RelayClient.connect(server);
    robot.send({ type: 'robot-source-hello' });
    const phone = await holder(server, 200, false);
    const unplayable = (status: any) => status.issues.find((issue: any) => issue.cause === 'robot-video-unplayable');

    assert.equal(unplayable(await productStatus(phone)), undefined);

    // Anyone but the Robot saying so is not evidence.
    phone.send({ type: 'robot-player-status', videoId: VIDEO, errorCode: 150 });
    await sleep(50);
    assert.equal(unplayable(await productStatus(phone)), undefined);

    // What the Robot host's Chromium reports for a region-restricted video.
    robot.send({ type: 'robot-player-status', videoId: VIDEO, errorCode: 150 });
    await sleep(50);
    assert.deepEqual(unplayable(await productStatus(phone)), {
      code: 'robot-player-unavailable',
      scope: 'robot',
      severity: 'critical',
      cause: 'robot-video-unplayable',
      affects: ['song', 'recording'],
      recovery: 'change-song',
    });
    const statusz = await (await fetch(server.httpUrl('/statusz'))).json() as any;
    assert.deepEqual(statusz.robot.playerError, { videoId: VIDEO, code: 150, unplayable: true });

    robot.send({ type: 'robot-player-status', videoId: VIDEO, errorCode: null });
    await sleep(50);
    assert.equal(unplayable(await productStatus(phone)), undefined);

    robot.close();
    phone.close();
  } finally {
    await server.stop();
  }
});
