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
  // These tests exercise the content path unless they explicitly opt into the
  // boot probe. Keeping the two mechanisms separate makes failures attributable.
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

async function liveSession(server: RelayServer) {
  const backing = await RelayClient.connect(server);
  backing.send({ type: 'register', role: 'backing', sampleRate: RATE });
  await backing.waitForType('registered');

  const publisher = await RelayClient.connect(server);
  publisher.send({ type: 'register', role: 'publisher', sampleRate: RATE });
  await publisher.waitForType('registered');

  const monitor = await RelayClient.connect(server);
  monitor.send({ type: 'register', role: 'monitor' });
  await monitor.waitForType('registered');
  await monitor.waitForType('test-status');

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
  monitor.send({ type: 'start-timing-calibration' });
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

describe('boot probe lifecycle', () => {
  test('does not carry a completed mic leg into a new live session', async () => {
    const server = await startRelay({
      ...FAST,
      RELAY_CALIBRATION_PROBE: '1',
      RELAY_CALIBRATION_PROBE_RETRY_MS: '1000',
      RELAY_CALIBRATION_PROBE_LEAD_MS: '20',
      RELAY_CALIBRATION_PROBE_SEARCH_MARGIN_MS: '200',
      // This test is about lifecycle, not detector quality. Let silence/noise
      // count as a found leg so the state machine can be driven deterministically.
      RELAY_CALIBRATION_PROBE_MIN_CORRELATION: '-2',
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

      // End the take after the first leg but before the backing leg can start.
      backing.close();
      await monitor.waitFor(
        (m) => m.type === 'source-status' && m.active === false,
        3_000,
      );

      // Snapshot the publisher's message queue before the new session exists,
      // so a fast probe request during priming cannot slip past the assertion.
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

test('robot follower applies only fresh server timeline snapshots', async () => {
  const source = await readFile(new URL('../public/source.js', import.meta.url), 'utf8');
  assert.doesNotMatch(
    source,
    /setInterval\s*\(\s*applyTimeline/,
    'replaying a serverTime snapshot on a local timer turns snapshot age into a false robot delta',
  );
  assert.match(source, /server already emits them every 250 ms/);
});