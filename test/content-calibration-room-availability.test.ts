import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RelayClient,
  pulseTrain,
  sendPcmInChunks,
  sleep,
  startCalibrationCollecting,
  startRelay,
  toInt16,
  type RelayServer,
} from './helpers/harness.js';

const RATE = 48_000;
const VIDEO = 'dQw4w9WgXcQ';

/**
 * The calibration timeout is deliberately long: this suite is about what a
 * *running* content measurement does to the room, so it must never be racing
 * that run to a settled state.
 */
const FAST = {
  RELAY_LIVE_PREBUFFER_MS: '200',
  RELAY_CALIBRATION_TIMEOUT_MS: '20000',
  RELAY_HEARTBEAT_MS: '60000',
  RELAY_AUTO_CALIBRATE: '0',
  RELAY_CALIBRATION_PROBE: '0',
};

/**
 * Media time that keeps up with wall clock. A Song whose reported position
 * stands still is a different room state - one that has its own product
 * meaning - so the clock has to look like it is really playing.
 */
function playing(startedAtMs: number) {
  return {
    type: 'youtube-telemetry',
    videoId: VIDEO,
    state: 1,
    currentTime: (Date.now() - startedAtMs) / 1000,
    duration: 200,
    playbackRate: 1,
    networkRttMs: 40,
  };
}

function tone(seconds: number, gain = 0.6, seed = 5) {
  return toInt16(pulseTrain(Math.round(RATE * seconds), RATE, seed), gain);
}

async function waitForNewMessage(
  client: RelayClient,
  fromIndex: number,
  predicate: (message: Record<string, any>) => boolean,
  timeoutMs = 8_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = client.messages.slice(fromIndex).find(predicate);
    if (found) return found;
    await sleep(20);
  }
  throw new Error(
    `Timed out waiting for message. Saw: ${client.messages.slice(fromIndex).map((m) => m.type).join(', ')}`,
  );
}

async function primeStreams(backing: RelayClient, singer: RelayClient) {
  await Promise.all([
    sendPcmInChunks(backing, tone(0.5, 0.8)),
    sendPcmInChunks(singer, tone(0.5, 0.4)),
  ]);
}

/**
 * One participant that is the phone: playback leader, room-song commander, Mic
 * owner and Take commander, which is exactly the surface this behaviour is
 * about.
 */
async function liveRoom(server: RelayServer) {
  const backing = await RelayClient.connect(server);
  backing.send({ type: 'register', role: 'backing', sampleRate: RATE });
  await backing.waitForType('registered');

  const singer = await RelayClient.connect(
    server,
    '?participant=content-singer-123&name=Mochi',
  );
  singer.send({ type: 'playback-hello', playbackTransportId: 'content-playback', playbackGeneration: 1 });
  await singer.waitFor((message) => message.type === 'playback-registered');

  singer.send({
    type: 'room-song-command',
    commandId: 'load-content',
    expectedRevision: 0,
    action: 'load',
    videoId: VIDEO,
    positionSeconds: 0,
  });
  await singer.waitFor((message) => (
    message.type === 'room-song-command-apply' && message.commandId === 'load-content'
  ));
  singer.send({ ...playing(Date.now()), currentTime: 0, state: 5 });
  await singer.waitFor((message) => (
    message.type === 'room-song-command-complete' && message.commandId === 'load-content'
  ));

  // Playing is a room-song decision, not a telemetry report: the room only
  // admits content calibration once the Song is authoritatively playing.
  singer.send({
    type: 'room-song-command',
    commandId: 'play-content',
    expectedRevision: 1,
    action: 'play',
  });
  await singer.waitFor((message) => (
    message.type === 'room-song-command-apply' && message.commandId === 'play-content'
  ));
  const songStartedAtMs = Date.now();
  singer.send(playing(songStartedAtMs));
  await singer.waitFor((message) => (
    message.type === 'room-song-command-complete' && message.commandId === 'play-content'
  ));

  singer.send({ type: 'register', role: 'publisher', sampleRate: RATE, captureGeneration: 1 });
  await singer.waitFor((message) => message.type === 'registered' && message.role === 'publisher');

  const monitor = await RelayClient.connect(server);
  monitor.send({ type: 'register', role: 'monitor' });
  await monitor.waitForType('registered');

  singer.send(playing(songStartedAtMs));
  await primeStreams(backing, singer);
  return { backing, singer, monitor, songStartedAtMs };
}

async function productStatus(singer: RelayClient) {
  const from = singer.messages.length;
  singer.send({ type: 'product-status-request' });
  return waitForNewMessage(singer, from, (message) => message.type === 'product-status');
}

test('a running content measurement leaves the room live and recordable', async () => {
  const server = await startRelay(FAST);
  try {
    const { backing, singer, monitor, songStartedAtMs } = await liveRoom(server);

    const collecting = await startCalibrationCollecting(singer, monitor, async () => {
      singer.send(playing(songStartedAtMs));
      await primeStreams(backing, singer);
    });
    assert.equal(collecting.state, 'collecting');

    // Keep both captures fresh, so what follows is an assertion about
    // calibration rather than about a room that quietly went stale while the
    // test was talking.
    singer.send(playing(songStartedAtMs));
    await primeStreams(backing, singer);

    const product = await productStatus(singer);
    assert.equal(product.lifecycle, 'live', 'a tap on the live audio is not a preparation stage');
    assert.equal(product.actions.canStartTake, true);
    assert.equal(product.actions.startTakeBlockedReason, null);
    assert.equal(
      product.actions.startCalibrationBlockedReason,
      'calibration-active',
      'the calibration path itself is still occupied',
    );

    const from = singer.messages.length;
    const monitorFrom = monitor.messages.length;
    singer.send({ type: 'start-take' });
    const accepted = await waitForNewMessage(singer, from, (message) => (
      message.type === 'take-command-accepted' && message.command === 'start'
    ));
    assert.ok(accepted.takeId);

    // The run is stood down so it cannot promote a new alignment into the
    // middle of the recording. Standing down is not a failure, so the room is
    // never told a calibration error occurred.
    const settled = await waitForNewMessage(monitor, monitorFrom, (message) => (
      message.type === 'timing-calibration-status' && message.state !== 'collecting'
    ));
    assert.equal(settled.state, 'idle');
    assert.equal(settled.error, null);

    backing.close();
    singer.close();
    monitor.close();
  } finally {
    await server.stop();
  }
});
