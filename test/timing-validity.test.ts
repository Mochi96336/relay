import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { describe } from 'node:test';

import {
  RelayClient,
  laggedPair,
  pulseTrain,
  sendPcmInChunks,
  sleep,
  startRelay,
  toInt16,
  type RelayServer,
} from './helpers/harness.js';

const RATE = 48_000;
const FAST = {
  RELAY_LIVE_PREBUFFER_MS: '200',
  RELAY_CALIBRATION_TIMEOUT_MS: '1500',
  RELAY_HEARTBEAT_MS: '60000',
  RELAY_AUTO_CALIBRATE: '0',
  RELAY_CALIBRATION_AGREEMENT: '1',
  RELAY_CALIBRATION_PROBE: '0',
};

const playingTelemetry = {
  type: 'youtube-telemetry',
  videoId: 'dQw4w9WgXcQ',
  state: 1,
  currentTime: 42,
  duration: 200,
  playbackRate: 1,
  networkRttMs: 40,
};

function tone(seconds: number, gain = 0.6, seed = 5) {
  return toInt16(pulseTrain(Math.round(RATE * seconds), RATE, seed), gain);
}

async function liveSession(server: RelayServer, robotBacking = false) {
  const backing = await RelayClient.connect(server);
  backing.send({ type: 'register', role: 'backing', sampleRate: RATE, robot: robotBacking });
  await backing.waitForType('registered');

  const publisher = await RelayClient.connect(server);
  publisher.send({ type: 'register', role: 'publisher', sampleRate: RATE });
  await publisher.waitForType('registered');

  const monitor = await RelayClient.connect(server);
  monitor.send({ type: 'register', role: 'monitor' });
  await monitor.waitForType('registered');

  return { backing, publisher, monitor };
}

async function primeStreams(backing: RelayClient, publisher: RelayClient) {
  await Promise.all([
    sendPcmInChunks(backing, tone(0.5, 0.8)),
    sendPcmInChunks(publisher, tone(0.5, 0.4)),
  ]);
}

async function calibrate(
  backing: RelayClient,
  publisher: RelayClient,
  monitor: RelayClient,
  lagMs = 260,
) {
  publisher.send(playingTelemetry);
  await primeStreams(backing, publisher);
  publisher.send({ type: 'start-timing-calibration' });
  await monitor.waitFor((m) => m.type === 'timing-calibration-status' && m.state === 'collecting');

  const { mic, backing: song } = laggedPair(8, RATE, lagMs);
  await Promise.all([
    sendPcmInChunks(backing, song),
    sendPcmInChunks(publisher, mic),
  ]);

  const complete = await monitor.waitFor(
    (m) => m.type === 'timing-calibration-status' && m.state === 'complete',
    10_000,
  );
  await monitor.waitFor(
    (m) => m.type === 'source-status' && m.timingMode === 'acoustic-calibration',
    3_000,
  );
  return complete;
}

async function waitForNewMessage(
  client: RelayClient,
  fromIndex: number,
  predicate: (message: Record<string, any>) => boolean,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = client.messages.slice(fromIndex).find(predicate);
    if (found) return found;
    await sleep(20);
  }
  throw new Error(
    `Timed out waiting for new message. Saw: ${client.messages.slice(fromIndex).map((m) => m.type).join(', ')}`,
  );
}

describe('timing validity boundary', () => {
  test('a restarted microphone keeps the old measurement only as history, not as mixer state', async () => {
    const server = await startRelay(FAST);
    try {
      const { backing, publisher, monitor } = await liveSession(server);
      const complete = await calibrate(backing, publisher, monitor);

      const restarted = await RelayClient.connect(server);
      restarted.newCaptureSession();
      restarted.send({ type: 'register', role: 'publisher', sampleRate: RATE });
      await restarted.waitForType('registered');
      await sendPcmInChunks(restarted, tone(0.5, 0.4));

      const stale = await monitor.waitFor(
        (m) => m.type === 'source-status'
          && m.calibrationStale === true
          && m.timingMode === 'network-estimate',
        4_000,
      );
      assert.equal(stale.calibratedMicLagMs, complete.micLagMs, 'history is still inspectable');
      assert.equal(stale.activeCalibratedMicLagMs, null, 'stale calibration is not applied');
      assert.equal(
        stale.requestedMicAdvanceMs,
        stale.micNetworkCompensationMs - stale.vocalFineTuneMs,
        'the mixer has fallen back to the network estimate',
      );

      const calibration = monitor.latest('timing-calibration-status');
      assert.equal(calibration?.micLagMs, complete.micLagMs, 'calibration status retains the measurement');
      assert.equal(calibration?.activeMicLagMs, null, 'calibration status exposes that it is inactive');

      backing.close();
      publisher.close();
      restarted.close();
      monitor.close();
    } finally {
      await server.stop();
    }
  });

  test('a restarted backing capture immediately stops applying the old calibration', async () => {
    const server = await startRelay(FAST);
    try {
      const { backing, publisher, monitor } = await liveSession(server);
      const complete = await calibrate(backing, publisher, monitor);

      const restarted = await RelayClient.connect(server);
      restarted.newCaptureSession();
      restarted.send({ type: 'register', role: 'backing', sampleRate: RATE });
      await restarted.waitForType('registered');
      await sendPcmInChunks(restarted, tone(0.5, 0.8));

      const stale = await monitor.waitFor(
        (m) => m.type === 'source-status'
          && m.calibrationStale === true
          && m.timingMode === 'network-estimate',
        4_000,
      );
      assert.equal(stale.calibratedMicLagMs, complete.micLagMs);
      assert.equal(stale.activeCalibratedMicLagMs, null);

      backing.close();
      restarted.close();
      publisher.close();
      monitor.close();
    } finally {
      await server.stop();
    }
  });

  test('a player seek invalidates the active sum until a fresh delta can replace it', async () => {
    const server = await startRelay(FAST);
    try {
      const { backing, publisher, monitor } = await liveSession(server);
      const complete = await calibrate(backing, publisher, monitor);

      backing.send({ type: 'source-seeked' });
      const stale = await monitor.waitFor(
        (m) => m.type === 'source-status'
          && m.calibrationStale === true
          && m.timingMode === 'network-estimate',
        4_000,
      );
      assert.equal(stale.calibratedMicLagMs, complete.micLagMs);
      assert.equal(stale.activeCalibratedMicLagMs, null);

      backing.close();
      publisher.close();
      monitor.close();
    } finally {
      await server.stop();
    }
  });
});

describe('robot calibration ownership', () => {
  const ROBOT_FAST = {
    ...FAST,
    RELAY_CALIBRATION_PROBE: '1',
    RELAY_CALIBRATION_PROBE_RETRY_MS: '100',
    RELAY_CALIBRATION_PROBE_LEAD_MS: '20',
    RELAY_CALIBRATION_PROBE_SEARCH_MARGIN_MS: '200',
    RELAY_CALIBRATION_PROBE_MIN_CORRELATION: '0',
    RELAY_CALIBRATION_PROBE_ANALYSIS_TIMEOUT_MS: '3000',
  };

  test('robot backing suppresses legacy auto-calibration before Chromium says hello', async () => {
    const server = await startRelay({ ...ROBOT_FAST, RELAY_AUTO_CALIBRATE: '1' });
    try {
      const { backing, publisher, monitor } = await liveSession(server, true);
      publisher.send(playingTelemetry);
      await primeStreams(backing, publisher);

      const probe = await publisher.waitFor(
        (m) => m.type === 'play-calibration-probe' && m.target === 'mic',
        3_000,
      );
      assert.equal(probe.target, 'mic');

      monitor.send({ type: 'timing-calibration-status-request' });
      const status = await monitor.waitFor(
        (m) => m.type === 'timing-calibration-status'
          && m.robotRoute === true
          && m.calibrationKind === 'boot-probe',
        3_000,
      );
      assert.notEqual(status.state, 'collecting', 'the legacy content collector must not win the launch race');

      backing.close();
      publisher.close();
      monitor.close();
    } finally {
      await server.stop();
    }
  });

  test('manual timing calibration on the robot restarts the boot probe, not song correlation', async () => {
    const server = await startRelay(ROBOT_FAST);
    try {
      const { backing, publisher, monitor } = await liveSession(server, true);
      const robot = await RelayClient.connect(server);
      robot.send({ type: 'robot-source-hello' });
      publisher.send(playingTelemetry);
      await primeStreams(backing, publisher);

      const from = publisher.messages.length;
      publisher.send({ type: 'start-timing-calibration' });
      const probe = await waitForNewMessage(
        publisher,
        from,
        (m) => m.type === 'play-calibration-probe' && m.target === 'mic',
        3_000,
      );
      assert.equal(probe.target, 'mic');

      monitor.send({ type: 'timing-calibration-status-request' });
      const status = await waitForNewMessage(
        monitor,
        monitor.messages.length - 1,
        (m) => m.type === 'timing-calibration-status' && m.calibrationKind === 'boot-probe',
        3_000,
      );
      assert.notEqual(status.state, 'collecting', 'manual robot calibration must never enter content collection');

      backing.close();
      publisher.close();
      monitor.close();
      robot.close();
    } finally {
      await server.stop();
    }
  });

  test('only the newest robot source can publish delta', async () => {
    const server = await startRelay(ROBOT_FAST);
    try {
      const monitor = await RelayClient.connect(server);
      monitor.send({ type: 'register', role: 'monitor' });
      await monitor.waitForType('registered');

      const first = await RelayClient.connect(server);
      first.send({ type: 'robot-source-hello' });
      const second = await RelayClient.connect(server);
      second.send({ type: 'robot-source-hello' });

      await first.waitForType('robot-source-replaced', 3_000);
      second.send({ type: 'robot-player-offset', offsetMs: 35 });
      first.send({ type: 'robot-player-offset', offsetMs: 900 });
      await sleep(50);

      const from = monitor.messages.length;
      monitor.send({ type: 'timing-calibration-status-request' });
      const status = await waitForNewMessage(
        monitor,
        from,
        (m) => m.type === 'timing-calibration-status',
        3_000,
      );
      assert.equal(Math.round(status.robotPlayerOffsetMs), 35, 'superseded robot delta must be ignored');
      assert.equal(status.robotSourceConnected, true);

      first.close();
      second.close();
      monitor.close();
    } finally {
      await server.stop();
    }
  });
});

describe('boot probe lifecycle', () => {
  test('does not carry a completed mic leg into a new live session', async () => {
    const server = await startRelay({
      ...FAST,
      RELAY_CALIBRATION_PROBE: '1',
      RELAY_CALIBRATION_PROBE_RETRY_MS: '1000',
      RELAY_CALIBRATION_PROBE_LEAD_MS: '20',
      RELAY_CALIBRATION_PROBE_SEARCH_MARGIN_MS: '200',
      RELAY_CALIBRATION_PROBE_MIN_CORRELATION: '0',
      RELAY_CALIBRATION_PROBE_ANALYSIS_TIMEOUT_MS: '3000',
      RELAY_BACKING_GRACE_MS: '100',
    });

    try {
      const { backing, publisher, monitor } = await liveSession(server);
      const robot = await RelayClient.connect(server);
      robot.send({ type: 'robot-source-hello' });
      await primeStreams(backing, publisher);

      const firstProbe = await publisher.waitFor(
        (m) => m.type === 'play-calibration-probe' && m.target === 'mic',
        4_000,
      );
      publisher.send({
        type: 'calibration-probe-played',
        target: 'mic',
        requestId: firstProbe.requestId,
        generation: publisher.generationId,
      });
      await sendPcmInChunks(publisher, tone(1.5, 0.4));

      await monitor.waitFor(
        (m) => m.type === 'timing-calibration-status' && m.probeCorrelation?.mic !== null,
        4_000,
      );

      backing.close();
      await monitor.waitFor(
        (m) => m.type === 'source-status' && m.active === false,
        3_000,
      );

      const from = publisher.messages.length;
      const newBacking = await RelayClient.connect(server);
      newBacking.newCaptureSession();
      newBacking.send({ type: 'register', role: 'backing', sampleRate: RATE });
      await newBacking.waitForType('registered');
      await Promise.all([
        sendPcmInChunks(newBacking, tone(1, 0.8)),
        sendPcmInChunks(publisher, tone(1, 0.4)),
      ]);

      const nextProbe = await waitForNewMessage(
        publisher,
        from,
        (m) => m.type === 'play-calibration-probe',
        4_000,
      );
      assert.equal(
        nextProbe.target,
        'mic',
        'a new session must start a new two-leg run instead of reusing the previous mic leg',
      );

      newBacking.close();
      publisher.close();
      monitor.close();
      robot.close();
    } finally {
      await server.stop();
    }
  });
});

test('robot follower applies only fresh server timeline snapshots and settled seek state', async () => {
  const source = await readFile(new URL('../public/source.js', import.meta.url), 'utf8');
  assert.doesNotMatch(
    source,
    /setInterval\s*\(\s*applyTimeline/,
    'replaying a serverTime snapshot on a local timer turns snapshot age into a false robot delta',
  );
  assert.match(source, /server already emits them every 250 ms/);
  assert.match(source, /ROBOT_DELTA_SETTLE_MS/);
  assert.ok(
    source.indexOf('if (shouldSeek)') < source.indexOf("send({ type: 'robot-player-offset'"),
    'seek detection must happen before a robot delta is published',
  );
  assert.match(source, /message\.type === 'robot-source-replaced'/);
  assert.match(source, /robotSuperseded/);
});
