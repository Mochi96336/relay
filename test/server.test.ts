import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';

import {
  RelayClient,
  laggedPair,
  sendPcmInChunks,
  sleep,
  startRelay,
  toInt16,
  pulseTrain,
  type RelayServer,
} from './helpers/harness.js';

const RATE = 48_000;
const FAST = {
  RELAY_LIVE_PREBUFFER_MS: '200',
  RELAY_CALIBRATION_TIMEOUT_MS: '1500',
  RELAY_HEARTBEAT_MS: '60000',
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

function silence(seconds: number) {
  return Buffer.alloc(Math.round(RATE * seconds) * 2);
}

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

describe('http surface', () => {
  let server: RelayServer;
  before(async () => { server = await startRelay(FAST); });
  after(async () => { await server.stop(); });

  test('serves a health endpoint', async () => {
    const response = await fetch(server.httpUrl('/healthz'));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  });

  test('serves the client page', async () => {
    const response = await fetch(server.httpUrl('/'));
    assert.equal(response.status, 200);
    assert.match(await response.text(), /RELAY \/ AUDIO PROTOTYPE/);
  });
});

describe('shared-key auth', () => {
  let server: RelayServer;
  before(async () => { server = await startRelay({ ...FAST, RELAY_KEY: 'sekrit' }); });
  after(async () => { await server.stop(); });

  test('refuses a websocket without the key', async () => {
    await assert.rejects(RelayClient.connect(server), /401|Unexpected server response/);
  });

  test('refuses a websocket with the wrong key', async () => {
    await assert.rejects(RelayClient.connect(server, '?key=wrong'), /401|Unexpected server response/);
  });

  test('accepts a websocket with the key', async () => {
    const client = await RelayClient.connect(server, '?key=sekrit');
    client.send({ type: 'register', role: 'monitor' });
    assert.equal((await client.waitForType('registered')).role, 'monitor');
    client.close();
  });
});

describe('microphone transport', () => {
  let server: RelayServer;
  before(async () => { server = await startRelay(FAST); });
  after(async () => { await server.stop(); });

  test('rejects an implausible sample rate', async () => {
    const client = await RelayClient.connect(server);
    client.send({ type: 'register', role: 'publisher', sampleRate: 3 });
    assert.match((await client.waitForType('error')).message, /sample rate/i);
    client.close();
  });

  test('forwards raw microphone PCM to monitors when no source is connected', async () => {
    const monitor = await RelayClient.connect(server);
    monitor.send({ type: 'register', role: 'monitor' });
    await monitor.waitForType('registered');

    const publisher = await RelayClient.connect(server);
    publisher.send({ type: 'register', role: 'publisher', sampleRate: RATE });
    await publisher.waitForType('registered');

    publisher.sendPcm(tone(0.1));
    await sleep(200);

    assert.ok(monitor.binaryFrames > 0, 'monitor received no raw PCM');
    publisher.close();
    monitor.close();
    await sleep(100);
  });
});

describe('live mix', () => {
  test('mixes the captured source with the microphone and reports healthy buffers', async () => {
    const server = await startRelay(FAST);
    try {
      const { backing, publisher, monitor } = await liveSession(server);

      const status = monitor.latest('test-status');
      assert.equal(status?.mode, 'tab-source', 'the live path must not masquerade as another mode');
      assert.equal(status?.sampleRate, RATE);

      // Prime both buffers well past the observation window. Feeding on a JS
      // timer would only measure the test's own timer accuracy.
      await sendPcmInChunks(backing, tone(3, 0.8));
      await sendPcmInChunks(publisher, tone(3, 0.4));
      await sleep(1_200);

      assert.ok(monitor.binaryFrames > 20, `only ${monitor.binaryFrames} mixed frames`);

      const health = await monitor.waitForType('mix-health', 3_000);
      assert.equal(health.active, true);
      assert.equal(health.micStarvedFrames, 0, 'a primed buffer must not starve');
      assert.equal(health.monitorDroppedFrames, 0);
      assert.ok(health.micHeadroomMs > 0, `headroom ${health.micHeadroomMs} ms`);

      backing.close();
      publisher.close();
      monitor.close();
    } finally {
      await server.stop();
    }
  });

  test('counts microphone starvation instead of silently mixing zeros', async () => {
    const server = await startRelay(FAST);
    try {
      const { backing, publisher, monitor } = await liveSession(server);

      // The song keeps arriving but the phone stops after a fraction of a
      // second, so the mixer's read head runs past the microphone history.
      await sendPcmInChunks(backing, tone(3, 0.8));
      await sendPcmInChunks(publisher, tone(0.2, 0.4));

      const health = await monitor.waitFor(
        (m) => m.type === 'mix-health' && m.micStarvedFrames > 0,
        6_000,
      );
      assert.ok(health.micHeadroomMs < 0, `headroom should be negative, got ${health.micHeadroomMs}`);
      assert.equal(health.backingStarvedFrames, 0, 'the song side was never short');

      backing.close();
      publisher.close();
      monitor.close();
    } finally {
      await server.stop();
    }
  });
});

describe('publisher takeover', () => {
  let server: RelayServer;
  before(async () => { server = await startRelay(FAST); });
  after(async () => { await server.stop(); });

  test('hands the slot to the newest connection instead of rejecting it', async () => {
    const first = await RelayClient.connect(server);
    first.send({ type: 'register', role: 'publisher', sampleRate: RATE });
    await first.waitForType('registered');

    // The old socket is still OPEN here, exactly like a phone that lost its
    // network before the heartbeat noticed.
    const second = await RelayClient.connect(server);
    second.send({ type: 'register', role: 'publisher', sampleRate: RATE });

    assert.equal((await second.waitForType('registered')).role, 'publisher');
    assert.deepEqual(second.errors, []);
    assert.match((await first.waitForType('error')).message, /Replaced/);

    first.close();
    second.close();
    await sleep(200);
  });
});

describe('timing calibration', () => {
  test('refuses to start without both sources', async () => {
    const server = await startRelay(FAST);
    try {
      const monitor = await RelayClient.connect(server);
      monitor.send({ type: 'register', role: 'monitor' });
      await monitor.waitForType('registered');

      monitor.send({ type: 'start-timing-calibration' });
      const status = await monitor.waitFor((m) => m.type === 'timing-calibration-status' && m.state === 'failed');
      assert.match(status.error, /Connect both/);
    } finally {
      await server.stop();
    }
  });

  test('refuses to start unless the phone is playing', async () => {
    const server = await startRelay(FAST);
    try {
      const { backing, publisher, monitor } = await liveSession(server);
      monitor.send({ type: 'start-timing-calibration' });

      const status = await monitor.waitFor((m) => m.type === 'timing-calibration-status' && m.state === 'failed');
      assert.match(status.error, /Play YouTube/);

      backing.close();
      publisher.close();
      monitor.close();
    } finally {
      await server.stop();
    }
  });

  test('times out instead of hanging when a stream stalls', async () => {
    const server = await startRelay(FAST);
    try {
      const { backing, publisher, monitor } = await liveSession(server);
      publisher.send(playingTelemetry);
      await sleep(100);

      monitor.send({ type: 'start-timing-calibration' });
      await monitor.waitFor((m) => m.type === 'timing-calibration-status' && m.state === 'collecting');

      // Only the source keeps streaming; the microphone side never fills.
      await sendPcmInChunks(backing, silence(1));

      const failed = await monitor.waitFor(
        (m) => m.type === 'timing-calibration-status' && m.state === 'failed',
        6_000,
      );
      assert.match(failed.error, /timed out/i);

      backing.close();
      publisher.close();
      monitor.close();
    } finally {
      await server.stop();
    }
  });

  test('measures an injected lag, then marks it stale after a microphone reconnect', async () => {
    const server = await startRelay(FAST);
    try {
      const { backing, publisher, monitor } = await liveSession(server);
      publisher.send(playingTelemetry);
      await sleep(100);

      monitor.send({ type: 'start-timing-calibration' });
      await monitor.waitFor((m) => m.type === 'timing-calibration-status' && m.state === 'collecting');

      const lagMs = 260;
      const { mic, backing: song } = laggedPair(6, RATE, lagMs);
      await sendPcmInChunks(backing, song);
      await sendPcmInChunks(publisher, mic);

      const complete = await monitor.waitFor(
        (m) => m.type === 'timing-calibration-status' && m.state === 'complete',
        10_000,
      );
      assert.ok(
        Math.abs(complete.micLagMs - lagMs) <= 15,
        `expected ~${lagMs} ms, got ${complete.micLagMs} ms`,
      );
      assert.equal(complete.calibrationStale, false);

      // finishTimingCalibration broadcasts the calibration status before the
      // source status, so wait for the one that carries the applied mode.
      const applied = await monitor.waitFor(
        (m) => m.type === 'source-status' && m.timingMode === 'acoustic-calibration',
        3_000,
      );
      assert.equal(applied.calibratedMicLagMs, complete.micLagMs);

      // A reconnect can change the transport delay the measurement folded in.
      const replacement = await RelayClient.connect(server);
      replacement.send({ type: 'register', role: 'publisher', sampleRate: RATE });
      await replacement.waitForType('registered');

      const stale = await monitor.waitFor(
        (m) => m.type === 'source-status' && m.calibrationStale === true,
        3_000,
      );
      assert.equal(stale.calibratedMicLagMs, complete.micLagMs, 'the value is kept, only flagged');

      backing.close();
      publisher.close();
      replacement.close();
      monitor.close();
    } finally {
      await server.stop();
    }
  });

  test('clears the calibration when the captured source disconnects', async () => {
    const server = await startRelay(FAST);
    try {
      const { backing, publisher, monitor } = await liveSession(server);
      publisher.send(playingTelemetry);
      await sleep(100);

      monitor.send({ type: 'start-timing-calibration' });
      await monitor.waitFor((m) => m.type === 'timing-calibration-status' && m.state === 'collecting');

      const { mic, backing: song } = laggedPair(6, RATE, 200);
      await sendPcmInChunks(backing, song);
      await sendPcmInChunks(publisher, mic);
      await monitor.waitFor((m) => m.type === 'timing-calibration-status' && m.state === 'complete', 10_000);

      backing.close();
      const cleared = await monitor.waitFor(
        (m) => m.type === 'source-status' && m.connected === false,
        3_000,
      );
      assert.equal(cleared.calibratedMicLagMs, null, 'a stale measurement must not survive the source');
      assert.equal(cleared.timingMode, 'network-estimate');

      publisher.close();
      monitor.close();
    } finally {
      await server.stop();
    }
  });
});
