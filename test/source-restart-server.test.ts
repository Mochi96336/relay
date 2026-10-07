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
  waitForNewMessage,
} from './helpers/harness.js';

const RATE = 48_000;
const FAST = {
  RELAY_LIVE_PREBUFFER_MS: '200',
  RELAY_CALIBRATION_TIMEOUT_MS: '5000',
  RELAY_HEARTBEAT_MS: '60000',
  RELAY_AUTO_CALIBRATE: '0',
  RELAY_CALIBRATION_AGREEMENT: '1',
  RELAY_CALIBRATION_PROBE: '0',
  RELAY_CALIBRATION_VALIDATION: '0',
};
const ROBOT = {
  ...FAST,
  RELAY_CALIBRATION_PROBE: '1',
  RELAY_CALIBRATION_PROBE_RETRY_MS: '100',
  RELAY_CALIBRATION_PROBE_LEAD_MS: '20',
  RELAY_CALIBRATION_PROBE_SEARCH_MARGIN_MS: '200',
  RELAY_CALIBRATION_PROBE_MIN_CORRELATION: '0',
  RELAY_CALIBRATION_PROBE_ANALYSIS_TIMEOUT_MS: '3000',
};

type Relay = Awaited<ReturnType<typeof startRelay>>;

const playingStartedAtMs = Date.now();
function playingTelemetry() {
  return {
    type: 'youtube-telemetry',
    videoId: 'dQw4w9WgXcQ',
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

async function room(server: Relay, { robot = false } = {}) {
  const backing = await RelayClient.connect(server);
  const publisher = await RelayClient.connect(server);
  const monitor = await RelayClient.connect(server);
  backing.send({ type: 'register', role: 'backing', sampleRate: RATE, robot });
  publisher.send({ type: 'register', role: 'publisher', sampleRate: RATE });
  monitor.send({ type: 'register', role: 'monitor' });
  await Promise.all([
    backing.waitForType('registered'),
    publisher.waitForType('registered'),
    monitor.waitForType('registered'),
  ]);
  const prime = async () => {
    publisher.send(playingTelemetry());
    await Promise.all([
      sendPcmInChunks(backing, tone(0.5, 0.8)),
      sendPcmInChunks(publisher, tone(0.5, 0.4)),
    ]);
  };
  return { backing, publisher, monitor, prime };
}

for (const side of ['publisher', 'backing'] as const) {
  const message = side === 'publisher'
    ? 'Microphone capture restarted during calibration. Start calibration again.'
    : 'Backing capture restarted during calibration. Start calibration again.';

  test(`a ${side === 'publisher' ? 'Mic' : 'Desktop Source'} that restarts its capture during calibration fails it`, async () => {
    const server = await startRelay(FAST);
    try {
      const clients = await room(server);
      await clients.prime();
      await startCalibrationCollecting(clients.publisher, clients.monitor, clients.prime);

      const from = clients.monitor.messages.length;
      clients[side].newCaptureSession();
      await sendPcmInChunks(clients[side], tone(0.2, 0.5));

      const failed = await waitForNewMessage(clients.monitor, from, (status) => (
        status.type === 'timing-calibration-status' && status.state === 'failed'
      ));
      assert.equal(failed.error, message);
    } finally {
      await server.stop();
    }
  });
}

for (const side of ['publisher', 'backing'] as const) {
  test(`a ${side === 'publisher' ? 'Mic' : 'Desktop Source'} that restarts its capture mid probe abandons the probe`, async () => {
    const server = await startRelay(ROBOT);
    try {
      const clients = await room(server, { robot: true });
      const robot = await RelayClient.connect(server);
      robot.send({ type: 'robot-source-hello' });
      await clients.prime();
      const probeFrom = clients.publisher.messages.length;
      clients.publisher.send({ type: 'start-timing-calibration' });
      await waitForNewMessage(clients.publisher, probeFrom, (message) => (
        message.type === 'play-calibration-probe' && message.target === 'mic'
      ));

      const from = clients.monitor.messages.length;
      clients[side].newCaptureSession();
      await sendPcmInChunks(clients[side], tone(0.2, 0.5));

      const abandoned = await waitForNewMessage(clients.monitor, from, (status) => (
        status.type === 'timing-calibration-status' && status.probeActive === false
      ), 1_000);
      assert.equal(abandoned.probePhase, 'idle');
    } finally {
      await server.stop();
    }
  });
}

test('a Desktop Source that does not come back leaves a singing room live, voice-only', async () => {
  const server = await startRelay({ ...ROBOT, RELAY_BACKING_GRACE_MS: '250' });
  try {
    const { backing, publisher, monitor } = await room(server, { robot: true });
    const robot = await RelayClient.connect(server);
    robot.send({ type: 'robot-source-hello' });
    await Promise.all([
      sendPcmInChunks(backing, tone(0.5, 0.8)),
      sendPcmInChunks(publisher, tone(0.5, 0.4)),
    ]);
    // A boot probe gives the room a Robot timing kind to lose.
    const probeFrom = publisher.messages.length;
    publisher.send({ type: 'start-timing-calibration' });
    await waitForNewMessage(publisher, probeFrom, (message) => message.type === 'play-calibration-probe');
    assert.equal((await statusz(server)).robot.route, true);

    robot.close();
    backing.close();
    await sendPcmInChunks(publisher, tone(0.5, 0.4));
    await sleep(700);

    const status = await statusz(server);
    assert.equal(status.mix.active, true, 'the singer is still there');
    assert.equal(status.robot.route, false, 'the Robot route went with its backing');
    const from = monitor.messages.length;
    monitor.send({ type: 'timing-calibration-status-request' });
    const timing = await waitForNewMessage(monitor, from, (message) => message.type === 'timing-calibration-status');
    assert.equal(timing.calibrationKind, 'none', 'Robot timing does not outlive the Robot route');
  } finally {
    await server.stop();
  }
});

test('a Desktop Source that does not come back stops a room nobody is singing in', async () => {
  const server = await startRelay({ ...FAST, RELAY_BACKING_GRACE_MS: '250' });
  try {
    const backing = await RelayClient.connect(server);
    backing.send({ type: 'register', role: 'backing', sampleRate: RATE });
    await backing.waitForType('registered');
    await sendPcmInChunks(backing, tone(0.5, 0.8));
    assert.equal((await statusz(server)).mix.active, true);

    backing.close();
    await sleep(600);
    assert.equal((await statusz(server)).mix.active, false);
  } finally {
    await server.stop();
  }
});
