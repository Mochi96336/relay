import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RelayClient,
  pulseTrain,
  sendPcmInChunks,
  startCalibrationCollecting,
  startRelay,
  toInt16,
  waitForNewMessage,
} from './helpers/harness.js';

const RATE = 48_000;
const VIDEO = 'dQw4w9WgXcQ';
const FAST = {
  RELAY_LIVE_PREBUFFER_MS: '200',
  RELAY_CALIBRATION_TIMEOUT_MS: '5000',
  RELAY_HEARTBEAT_MS: '60000',
  RELAY_AUTO_CALIBRATE: '0',
  RELAY_CALIBRATION_AGREEMENT: '1',
  RELAY_CALIBRATION_PROBE: '0',
  RELAY_CALIBRATION_VALIDATION: '0',
};

type Relay = Awaited<ReturnType<typeof startRelay>>;

const playingStartedAtMs = Date.now();
function playingTelemetry() {
  return {
    type: 'youtube-telemetry',
    videoId: VIDEO,
    state: 1,
    currentTime: 42 + (Date.now() - playingStartedAtMs) / 1_000,
    duration: 200,
    playbackRate: 1,
    networkRttMs: 40,
  };
}

function tone(seconds: number, gain: number) {
  return toInt16(pulseTrain(Math.round(RATE * seconds), RATE, 5), gain);
}

async function statusz(server: Relay) {
  return (await fetch(server.httpUrl('/statusz'))).json();
}

/** A Desktop Source, a publisher without a lease and a monitor, calibrating. */
async function calibratingDesktopRoom(server: Relay) {
  const backing = await RelayClient.connect(server);
  const monitor = await RelayClient.connect(server);
  const publisher = await RelayClient.connect(server);
  backing.send({ type: 'register', role: 'backing', sampleRate: RATE });
  monitor.send({ type: 'register', role: 'monitor' });
  publisher.send({ type: 'register', role: 'publisher', sampleRate: RATE });
  await Promise.all([
    backing.waitForType('registered'),
    monitor.waitForType('registered'),
    publisher.waitForType('registered'),
  ]);
  const prime = async () => {
    publisher.send(playingTelemetry());
    await Promise.all([
      sendPcmInChunks(backing, tone(0.5, 0.8)),
      sendPcmInChunks(publisher, tone(0.5, 0.4)),
    ]);
  };
  await prime();
  await startCalibrationCollecting(publisher, monitor, prime);
  return { backing, monitor, publisher };
}

test('a Desktop Source that closes during calibration fails it and leaves the mix', async () => {
  const server = await startRelay(FAST);
  try {
    const { backing, monitor, publisher } = await calibratingDesktopRoom(server);

    const from = monitor.messages.length;
    backing.close();

    const failed = await waitForNewMessage(monitor, from, (message) => (
      message.type === 'timing-calibration-status' && message.state === 'failed'
    ));
    assert.equal(failed.error, 'Desktop Source disconnected during calibration.');
    await waitForNewMessage(monitor, from, (message) => (
      message.type === 'source-status' && message.connected === false
    ), 1_000);

    // The voice carries on past the song's retained audio. A Desktop Source
    // that left is not one that is starving the mix.
    await sendPcmInChunks(publisher, tone(1, 0.4));
    const deadline = Date.now() + 3_000;
    let status = await statusz(server);
    while (status.mix.backingHeadroomMs > -200 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      status = await statusz(server);
    }
    assert.ok(status.mix.backingHeadroomMs <= -200, 'the song\'s retained audio has run out');
    assert.equal(status.source.backingSampleRate, null);
    assert.equal(status.mix.backingStarvedFrames, 0);
  } finally {
    await server.stop();
  }
});

const ROBOT = {
  ...FAST,
  RELAY_CALIBRATION_PROBE: '1',
  RELAY_CALIBRATION_PROBE_RETRY_MS: '100',
  RELAY_CALIBRATION_PROBE_LEAD_MS: '20',
  RELAY_CALIBRATION_PROBE_SEARCH_MARGIN_MS: '200',
  RELAY_CALIBRATION_PROBE_MIN_CORRELATION: '0',
  RELAY_CALIBRATION_PROBE_ANALYSIS_TIMEOUT_MS: '3000',
};

test('a Robot source that closes mid probe abandons the probe and says it is gone', async () => {
  const server = await startRelay(ROBOT);
  try {
    const backing = await RelayClient.connect(server);
    const publisher = await RelayClient.connect(server);
    const monitor = await RelayClient.connect(server);
    backing.send({ type: 'register', role: 'backing', sampleRate: RATE, robot: true });
    publisher.send({ type: 'register', role: 'publisher', sampleRate: RATE });
    monitor.send({ type: 'register', role: 'monitor' });
    await Promise.all([
      backing.waitForType('registered'),
      publisher.waitForType('registered'),
      monitor.waitForType('registered'),
    ]);
    const robot = await RelayClient.connect(server);
    robot.send({ type: 'robot-source-hello' });
    publisher.send(playingTelemetry());
    await Promise.all([
      sendPcmInChunks(backing, tone(0.5, 0.8)),
      sendPcmInChunks(publisher, tone(0.5, 0.4)),
    ]);
    const probeFrom = publisher.messages.length;
    publisher.send({ type: 'start-timing-calibration' });
    await waitForNewMessage(publisher, probeFrom, (message) => (
      message.type === 'play-calibration-probe' && message.target === 'mic'
    ));

    const from = monitor.messages.length;
    robot.close();
    await waitForNewMessage(monitor, from, (message) => (
      message.type === 'source-status' && message.robotSourceConnected === false
    ), 1_000);
    const timing = await waitForNewMessage(monitor, from, (message) => (
      message.type === 'timing-calibration-status' && message.robotSourceConnected === false
    ));
    assert.equal(timing.probeActive, false, 'the boot probe was measuring a Robot that is gone');
    assert.equal(timing.probePhase, 'idle');

  } finally {
    await server.stop();
  }
});

function songTelemetry(currentTime: number, state = 1) {
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

function participantQuery(id: string, name: string) {
  return `?${new URLSearchParams({ participant: id, name }).toString()}`;
}

test('a playback tab that closes fails the room command it owed at once, and leaves the Song', async () => {
  const server = await startRelay({ RELAY_AUTO_CALIBRATE: '0', RELAY_HEARTBEAT_MS: '60000' });
  try {
    const observer = await RelayClient.connect(server, participantQuery('participant-watch', 'Watcher'));
    const playback = await RelayClient.connect(server, participantQuery('participant-alice', 'Alice'));
    playback.send({ type: 'playback-hello', playbackTransportId: 'playback-tab-a', playbackGeneration: 1 });
    await playback.waitForType('playback-registered');
    const publisher = await RelayClient.connect(server, participantQuery('participant-alice', 'Alice'));
    publisher.send({ type: 'register', role: 'publisher', sampleRate: RATE, captureGeneration: 1 });
    await publisher.waitFor((message) => message.type === 'registered' && message.role === 'publisher');

    playback.send({
      type: 'room-song-command', commandId: 'close-test-load', expectedRevision: 0,
      action: 'load', videoId: VIDEO, positionSeconds: 10,
    });
    const loadAnswer = await playback.waitFor((message) => (message.type === 'room-song-command-apply' || message.type === 'room-song-command-rejected') && message.commandId === 'close-test-load');
    assert.equal(loadAnswer.type, 'room-song-command-apply', JSON.stringify(loadAnswer));
    playback.send(songTelemetry(10, 5));
    await playback.waitFor((message) => message.type === 'room-song-command-complete' && message.commandId === 'close-test-load');
    playback.send({ type: 'room-song-command', commandId: 'close-test-play', expectedRevision: 1, action: 'play' });
    await playback.waitFor((message) => message.type === 'room-song-command-apply' && message.commandId === 'close-test-play');
    playback.send(songTelemetry(10.05));
    await playback.waitFor((message) => message.type === 'room-song-command-complete' && message.commandId === 'close-test-play');

    // The tab is asked to pause and closes before it answers.
    playback.send({ type: 'room-song-command', commandId: 'close-test-pause', expectedRevision: 2, action: 'pause' });
    await playback.waitFor((message) => message.type === 'room-song-command-apply' && message.commandId === 'close-test-pause');

    const from = observer.messages.length;
    playback.close();
    const failed = await waitForNewMessage(observer, from, (message) => (
      message.type === 'room-song-command-failed-ack' && message.commandId === 'close-test-pause'
    ), 1_000);
    assert.equal(failed.reason, 'playback-disconnected');
    await waitForNewMessage(observer, from, (message) => (
      message.type === 'room-song-command-status' && message.pendingCommandId === null
    ), 1_000);
    await waitForNewMessage(observer, from, (message) => (
      message.type === 'youtube-timeline-status' && message.leaderConnected === false
    ), 1_000);
  } finally {
    await server.stop();
  }
});
