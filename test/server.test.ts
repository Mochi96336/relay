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
  // Off by default here so tests that drive calibration by hand are not racing
  // the unattended trigger. The auto path has its own test.
  RELAY_AUTO_CALIBRATE: '0',
  // One window unless a test is specifically about agreement, so the rest do
  // not have to synthesise three windows of audio to say anything.
  RELAY_CALIBRATION_AGREEMENT: '1',
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

/**
 * Gets audio genuinely moving on both sides. Calibration refuses to start
 * against a registered-but-silent client, because that spends the whole window
 * receiving nothing and says only that progress stopped.
 */
async function primeStreams(backing: RelayClient, publisher: RelayClient) {
  await Promise.all([
    sendPcmInChunks(backing, tone(0.5, 0.8)),
    sendPcmInChunks(publisher, tone(0.5, 0.4)),
  ]);
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

describe('remote status', () => {
  let server: RelayServer;
  before(async () => { server = await startRelay(FAST); });
  after(async () => { await server.stop(); });

  const status = async () => (await fetch(server.httpUrl('/statusz'))).json();

  test('calls a server with nothing connected idle rather than broken', async () => {
    const body = await status();
    assert.equal(body.ok, true);
    assert.equal(body.state, 'idle');
    assert.deepEqual(body.faults, []);
    assert.equal(body.source.backingConnected, false);
    assert.equal(body.source.backingFrameAgeMs, null);
  });

  /**
   * The failure a liveness probe cannot see. Every process is still up and the
   * socket is still open; only the audio stopped, which is what a dead browser
   * or a collapsed capture looks like from the server.
   */
  test('faults when a connected source stops sending audio', async () => {
    const backing = await RelayClient.connect(server);
    backing.send({ type: 'register', role: 'backing', sampleRate: RATE });
    await backing.waitForType('registered');
    await sendPcmInChunks(backing, tone(0.3));

    const streaming = await status();
    assert.equal(streaming.ok, true);
    assert.equal(streaming.state, 'live');
    assert.equal(streaming.source.backingStreaming, true);

    await sleep(1_200);

    const stalled = await status();
    assert.equal(stalled.ok, false);
    assert.equal(stalled.state, 'fault');
    assert.match(stalled.faults.join(' '), /backing source is connected but no longer sending audio/);
    assert.ok(stalled.source.backingFrameAgeMs >= 1_000);
    backing.close();
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

  test('forwards the authoritative voice-only mix to monitors when no source is connected', async () => {
    const monitor = await RelayClient.connect(server);
    monitor.send({ type: 'register', role: 'monitor' });
    await monitor.waitForType('registered');

    const publisher = await RelayClient.connect(server);
    publisher.send({ type: 'register', role: 'publisher', sampleRate: RATE });
    await publisher.waitForType('registered');

    publisher.sendPcm(tone(0.1));
    await sleep(450);

    assert.equal(monitor.latest('source-status')?.active, true);
    assert.ok(monitor.binaryFrames > 0, 'monitor received no voice-only mixed PCM');
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

      assert.equal(monitor.latest('test-status')?.active, false, 'no test is running');
      assert.equal(monitor.latest('test-status')?.mode, 'off');

      const live = monitor.latest('source-status');
      assert.equal(live?.active, true, 'the live session describes itself');
      assert.equal(live?.mixSampleRate, RATE);

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

describe('framed pcm', () => {
  test('reports a hole when the uplink drops chunks, instead of pulling audio earlier', async () => {
    const server = await startRelay(FAST);
    try {
      const { backing, publisher, monitor } = await liveSession(server);

      await sendPcmInChunks(backing, tone(3, 0.8));
      await sendPcmInChunks(publisher, tone(1, 0.4));
      publisher.skipPcm(Buffer.alloc(Math.round(RATE * 0.4) * 2));
      await sendPcmInChunks(publisher, tone(1, 0.4));

      const health = await monitor.waitFor(
        (m) => m.type === 'mix-health' && m.micGapMs > 0,
        6_000,
      );
      assert.ok(
        Math.abs(health.micGapMs - 400) <= 25,
        `expected a ~400 ms hole, got ${health.micGapMs} ms`,
      );
      assert.equal(health.backingGapMs, 0, 'the song stream was continuous');
      assert.equal(health.unheadered, false);

      backing.close();
      publisher.close();
      monitor.close();
    } finally {
      await server.stop();
    }
  });

  test('keeps mixing the song while the microphone is away', async () => {
    const server = await startRelay(FAST);
    try {
      const { backing, publisher, monitor } = await liveSession(server);
      await sendPcmInChunks(backing, tone(3, 0.8));
      await sendPcmInChunks(publisher, tone(0.5, 0.4));
      await sleep(400);

      const before = monitor.binaryFrames;
      publisher.close();
      await sleep(800);

      assert.ok(
        monitor.binaryFrames > before + 20,
        `mix stalled without the phone: ${monitor.binaryFrames - before} frames`,
      );

      backing.close();
      monitor.close();
    } finally {
      await server.stop();
    }
  });

  test('rejoins the existing timeline after a transport outage', async () => {
    const server = await startRelay(FAST);
    try {
      const { backing, publisher, monitor } = await liveSession(server);
      await sendPcmInChunks(backing, tone(4, 0.8));
      await sendPcmInChunks(publisher, tone(1, 0.4));
      await sleep(300);

      const cursor = publisher.cursor;
      const framesBefore = monitor.binaryFrames;
      publisher.close();
      await sleep(400);

      const rejoined = await RelayClient.connect(server);
      rejoined.resumeCaptureSession(publisher.generationId, cursor + Math.round(RATE * 0.4));
      rejoined.send({ type: 'register', role: 'publisher', sampleRate: RATE });
      await rejoined.waitForType('registered');
      await sendPcmInChunks(rejoined, tone(1, 0.4));

      await sleep(600);
      assert.ok(
        monitor.binaryFrames > framesBefore + 30,
        'output paused for a fresh prebuffer instead of continuing',
      );

      const health = await monitor.waitFor((m) => m.type === 'mix-health' && m.micGapMs > 0, 4_000);
      assert.ok(health.micGapMs > 200, `outage should show as a hole, got ${health.micGapMs} ms`);

      backing.close();
      rejoined.close();
      monitor.close();
    } finally {
      await server.stop();
    }
  });

  test('still accepts a client that predates the framing', async () => {
    const server = await startRelay(FAST);
    try {
      const { backing, publisher, monitor } = await liveSession(server);
      await sendPcmInChunks(backing, tone(2, 0.8));
      publisher.sendUnheaderedPcm(tone(0.5, 0.4));

      const health = await monitor.waitFor((m) => m.type === 'mix-health' && m.unheadered === true, 4_000);
      assert.equal(health.unheadered, true, 'a stale client must be visible, not silently degraded');

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

  test('retires the old anonymous publisher with a terminal semantic message', async () => {
    const first = await RelayClient.connect(server);
    first.send({ type: 'register', role: 'publisher', sampleRate: RATE });
    await first.waitForType('registered');

    const second = await RelayClient.connect(server);
    second.send({ type: 'register', role: 'publisher', sampleRate: RATE });

    assert.equal((await second.waitForType('registered')).role, 'publisher');
    assert.deepEqual(second.errors, []);
    assert.match((await first.waitForType('mic-revoked')).message, /took over the microphone/i);
    assert.deepEqual(first.errors, [], 'publisher replacement is protocol state, not a transport error');

    first.close();
    second.close();
    await sleep(200);
  });
});

describe('mix settings', () => {
  let server: RelayServer;
  before(async () => { server = await startRelay(FAST); });
  after(async () => { await server.stop(); });

  test('carries song level so the phone can drive the machine playing the song', async () => {
    const phone = await RelayClient.connect(server);
    phone.send({ type: 'register', role: 'publisher', sampleRate: RATE });
    await phone.waitForType('registered');

    const desktop = await RelayClient.connect(server);
    desktop.send({ type: 'register', role: 'monitor' });
    await desktop.waitForType('registered');

    phone.send({ type: 'set-mix', micGainDb: 18, songLevel: 25 });

    const settings = await desktop.waitFor(
      (m) => m.type === 'mix-settings' && m.songLevel === 25,
      3_000,
    );
    assert.equal(settings.micGainDb, 18);

    phone.close();
    desktop.close();
    await sleep(100);
  });

  test('clamps a song level outside the slider range', async () => {
    const phone = await RelayClient.connect(server);
    phone.send({ type: 'register', role: 'publisher', sampleRate: RATE });
    await phone.waitForType('registered');

    phone.send({ type: 'set-mix', songLevel: 900 });
    await phone.waitFor((m) => m.type === 'mix-settings' && m.songLevel === 100, 3_000);

    phone.send({ type: 'set-mix', songLevel: -40 });
    await phone.waitFor((m) => m.type === 'mix-settings' && m.songLevel === 0, 3_000);

    phone.close();
    await sleep(100);
  });
});

describe('timing calibration', () => {
  test('refuses to start without both sources', async () => {
    const server = await startRelay(FAST);
    try {
      const publisher = await RelayClient.connect(server);
      publisher.send({ type: 'register', role: 'publisher', sampleRate: RATE });
      await publisher.waitForType('registered');

      const monitor = await RelayClient.connect(server);
      monitor.send({ type: 'register', role: 'monitor' });
      await monitor.waitForType('registered');

      publisher.send({ type: 'start-timing-calibration' });
      const status = await monitor.waitFor((m) => m.type === 'timing-calibration-status' && m.state === 'failed');
      assert.match(status.error, /Connect both/);

      publisher.close();
      monitor.close();
    } finally {
      await server.stop();
    }
  });

  test('refuses to start unless the phone is playing', async () => {
    const server = await startRelay(FAST);
    try {
      const { backing, publisher, monitor } = await liveSession(server);
      // Make playback the only missing prerequisite. A registered-but-silent
      // source is a different contract and has its own regression below.
      await primeStreams(backing, publisher);
      publisher.send({ type: 'start-timing-calibration' });

      const status = await monitor.waitFor((m) => m.type === 'timing-calibration-status' && m.state === 'failed');
      assert.match(status.error, /Play YouTube/);

      backing.close();
      publisher.close();
      monitor.close();
    } finally {
      await server.stop();
    }
  });

  test('refuses to start against a connected source that is not streaming', async () => {
    const server = await startRelay(FAST);
    try {
      const { backing, publisher, monitor } = await liveSession(server);
      publisher.send(playingTelemetry);
      await sendPcmInChunks(publisher, tone(0.5, 0.4));

      publisher.send({ type: 'start-timing-calibration' });
      const failed = await monitor.waitFor(
        (m) => m.type === 'timing-calibration-status' && m.state === 'failed',
        3_000,
      );
      assert.match(failed.error, /no audio arriving from the desktop capture/i);
      assert.match(failed.error, /restart the backing source/i, 'and says what to do about it');

      backing.close();
      publisher.close();
      monitor.close();
    } finally {
      await server.stop();
    }
  });

  test('names the side that went quiet instead of stalling at 0 %', async () => {
    const server = await startRelay({ ...FAST, RELAY_CALIBRATION_TIMEOUT_MS: '20000' });
    try {
      const { backing, publisher, monitor } = await liveSession(server);
      publisher.send(playingTelemetry);
      await primeStreams(backing, publisher);

      publisher.send({ type: 'start-timing-calibration' });
      await monitor.waitFor((m) => m.type === 'timing-calibration-status' && m.state === 'collecting');

      await sendPcmInChunks(backing, silence(2));

      const failed = await monitor.waitFor(
        (m) => m.type === 'timing-calibration-status' && m.state === 'failed',
        6_000,
      );
      assert.match(failed.error, /no audio from the phone microphone/i);

      backing.close();
      publisher.close();
      monitor.close();
    } finally {
      await server.stop();
    }
  });

  test('measures an injected lag and survives a socket-only reconnect', async () => {
    const server = await startRelay(FAST);
    try {
      const { backing, publisher, monitor } = await liveSession(server);
      publisher.send(playingTelemetry);
      await primeStreams(backing, publisher);

      publisher.send({ type: 'start-timing-calibration' });
      await monitor.waitFor((m) => m.type === 'timing-calibration-status' && m.state === 'collecting');

      const lagMs = 260;
      const { mic, backing: song } = laggedPair(8, RATE, lagMs);
      await Promise.all([
        sendPcmInChunks(backing, song),
        sendPcmInChunks(publisher, mic),
      ]);

      const complete = await monitor.waitFor(
        (m) => m.type === 'timing-calibration-status' && m.state === 'complete',
        10_000,
      );
      assert.ok(
        Math.abs(complete.micLagMs - lagMs) <= 15,
        `expected ~${lagMs} ms, got ${complete.micLagMs} ms`,
      );
      assert.equal(complete.calibrationStale, false);

      const applied = await monitor.waitFor(
        (m) => m.type === 'source-status' && m.timingMode === 'acoustic-calibration',
        3_000,
      );
      assert.equal(applied.calibratedMicLagMs, complete.micLagMs);

      const cursor = publisher.cursor;
      publisher.close();
      await sleep(300);

      const rejoined = await RelayClient.connect(server);
      rejoined.resumeCaptureSession(publisher.generationId, cursor + Math.round(RATE * 0.3));
      rejoined.send({ type: 'register', role: 'publisher', sampleRate: RATE });
      await rejoined.waitForType('registered');
      await sendPcmInChunks(rejoined, tone(0.5, 0.4));
      await sleep(400);

      const afterRejoin = monitor.latest('source-status');
      assert.equal(afterRejoin?.calibrationStale, false, 'a socket reconnect must not invalidate the measurement');
      assert.equal(afterRejoin?.calibratedMicLagMs, complete.micLagMs);

      backing.close();
      rejoined.close();
      monitor.close();
    } finally {
      await server.stop();
    }
  });

  test('marks the measurement stale when the microphone capture restarts', async () => {
    const server = await startRelay(FAST);
    try {
      const { backing, publisher, monitor } = await liveSession(server);
      publisher.send(playingTelemetry);
      await primeStreams(backing, publisher);

      publisher.send({ type: 'start-timing-calibration' });
      await monitor.waitFor((m) => m.type === 'timing-calibration-status' && m.state === 'collecting');

      const { mic, backing: song } = laggedPair(8, RATE, 260);
      await sendPcmInChunks(backing, song);
      await sendPcmInChunks(publisher, mic);
      const complete = await monitor.waitFor(
        (m) => m.type === 'timing-calibration-status' && m.state === 'complete',
        10_000,
      );

      const restarted = await RelayClient.connect(server);
      restarted.newCaptureSession();
      restarted.send({ type: 'register', role: 'publisher', sampleRate: RATE });
      await restarted.waitForType('registered');
      await sendPcmInChunks(restarted, tone(0.5, 0.4));

      const stale = await monitor.waitFor(
        (m) => m.type === 'source-status' && m.calibrationStale === true,
        4_000,
      );
      assert.equal(stale.calibratedMicLagMs, complete.micLagMs, 'the value is kept, only flagged');

      backing.close();
      publisher.close();
      restarted.close();
      monitor.close();
    } finally {
      await server.stop();
    }
  });

  test('marks the measurement stale when the backing capture restarts', async () => {
    const server = await startRelay(FAST);
    try {
      const { backing, publisher, monitor } = await liveSession(server);
      publisher.send(playingTelemetry);
      await primeStreams(backing, publisher);

      publisher.send({ type: 'start-timing-calibration' });
      await monitor.waitFor((m) => m.type === 'timing-calibration-status' && m.state === 'collecting');

      const { mic, backing: song } = laggedPair(8, RATE, 260);
      await sendPcmInChunks(backing, song);
      await sendPcmInChunks(publisher, mic);
      const complete = await monitor.waitFor(
        (m) => m.type === 'timing-calibration-status' && m.state === 'complete',
        10_000,
      );

      const restarted = await RelayClient.connect(server);
      restarted.newCaptureSession();
      restarted.send({ type: 'register', role: 'backing', sampleRate: RATE });
      await restarted.waitForType('registered');
      await sendPcmInChunks(restarted, tone(0.5, 0.8));

      const stale = await monitor.waitFor(
        (m) => m.type === 'source-status' && m.calibrationStale === true,
        4_000,
      );
      assert.equal(stale.calibratedMicLagMs, complete.micLagMs, 'the old value is retained but flagged');

      backing.close();
      restarted.close();
      publisher.close();
      monitor.close();
    } finally {
      await server.stop();
    }
  });

  test('measures on its own when nobody is at the desktop', async () => {
    const server = await startRelay({ ...FAST, RELAY_AUTO_CALIBRATE: '1' });
    try {
      const { backing, publisher, monitor } = await liveSession(server);
      publisher.send(playingTelemetry);

      await Promise.all([
        sendPcmInChunks(backing, tone(1, 0.8)),
        sendPcmInChunks(publisher, tone(1, 0.4)),
      ]);

      await monitor.waitFor(
        (m) => m.type === 'timing-calibration-status' && m.state === 'collecting',
        3_000,
      );

      const { mic, backing: song } = laggedPair(8, RATE, 260);
      await Promise.all([
        sendPcmInChunks(backing, song),
        sendPcmInChunks(publisher, mic),
      ]);

      const complete = await monitor.waitFor(
        (m) => m.type === 'timing-calibration-status' && m.state === 'complete',
        10_000,
      );
      assert.ok(Math.abs(complete.micLagMs - 260) <= 25, `got ${complete.micLagMs} ms`);
      assert.equal(complete.automatic, true, 'and says it was unattended');

      const applied = await monitor.waitFor(
        (m) => m.type === 'source-status' && m.timingMode === 'acoustic-calibration',
        3_000,
      );
      assert.equal(applied.calibratedMicLagMs, complete.micLagMs);

      backing.close();
      publisher.close();
      monitor.close();
    } finally {
      await server.stop();
    }
  });

  test('holds the answer back until independent windows agree', async () => {
    const server = await startRelay({ ...FAST, RELAY_CALIBRATION_AGREEMENT: '2' });
    try {
      const { backing, publisher, monitor } = await liveSession(server);
      publisher.send(playingTelemetry);
      await primeStreams(backing, publisher);

      publisher.send({ type: 'start-timing-calibration' });
      await monitor.waitFor((m) => m.type === 'timing-calibration-status' && m.state === 'collecting');

      const { mic, backing: song } = laggedPair(16, RATE, 260);
      await Promise.all([
        sendPcmInChunks(backing, song),
        sendPcmInChunks(publisher, mic),
      ]);

      const complete = await monitor.waitFor(
        (m) => m.type === 'timing-calibration-status' && m.state === 'complete',
        15_000,
      );
      assert.ok(Math.abs(complete.micLagMs - 260) <= 15, `got ${complete.micLagMs} ms`);
      assert.equal(complete.windowsNeeded, 2);

      backing.close();
      publisher.close();
      monitor.close();
    } finally {
      await server.stop();
    }
  });

  test('waits for the phone to actually stream, not just to connect', async () => {
    const server = await startRelay({ ...FAST, RELAY_AUTO_CALIBRATE: '1' });
    try {
      const { backing, publisher, monitor } = await liveSession(server);
      publisher.send(playingTelemetry);

      await sendPcmInChunks(backing, tone(2, 0.8));
      await sleep(800);

      assert.notEqual(
        monitor.latest('timing-calibration-status')?.state,
        'collecting',
        'a measurement against a silent microphone is worse than none',
      );

      backing.close();
      publisher.close();
      monitor.close();
    } finally {
      await server.stop();
    }
  });

  test('does not keep re-measuring once it has a usable answer', async () => {
    const server = await startRelay({
      ...FAST,
      RELAY_AUTO_CALIBRATE: '1',
      RELAY_AUTO_CALIBRATION_RETRY_MS: '300',
    });
    try {
      const { backing, publisher, monitor } = await liveSession(server);
      publisher.send(playingTelemetry);

      await Promise.all([
        sendPcmInChunks(backing, tone(1, 0.8)),
        sendPcmInChunks(publisher, tone(1, 0.4)),
      ]);
      await monitor.waitFor((m) => m.type === 'timing-calibration-status' && m.state === 'collecting', 3_000);
      const { mic, backing: song } = laggedPair(8, RATE, 260);
      await Promise.all([
        sendPcmInChunks(backing, song),
        sendPcmInChunks(publisher, mic),
      ]);
      await monitor.waitFor((m) => m.type === 'timing-calibration-status' && m.state === 'complete', 10_000);

      await sleep(1_200);
      assert.equal(
        monitor.latest('timing-calibration-status')?.state,
        'complete',
        'a valid measurement must not be replaced on a timer',
      );

      backing.close();
      publisher.close();
      monitor.close();
    } finally {
      await server.stop();
    }
  });

  test('marks the measurement stale when the desktop player is seeked', async () => {
    const server = await startRelay(FAST);
    try {
      const { backing, publisher, monitor } = await liveSession(server);
      publisher.send(playingTelemetry);
      await primeStreams(backing, publisher);

      publisher.send({ type: 'start-timing-calibration' });
      await monitor.waitFor((m) => m.type === 'timing-calibration-status' && m.state === 'collecting');

      const { mic, backing: song } = laggedPair(8, RATE, 260);
      await Promise.all([
        sendPcmInChunks(backing, song),
        sendPcmInChunks(publisher, mic),
      ]);
      const complete = await monitor.waitFor(
        (m) => m.type === 'timing-calibration-status' && m.state === 'complete',
        10_000,
      );
      assert.equal(complete.calibrationStale, false);

      backing.send({ type: 'source-seeked' });

      const stale = await monitor.waitFor(
        (m) => m.type === 'source-status' && m.calibrationStale === true,
        4_000,
      );
      assert.equal(stale.calibratedMicLagMs, complete.micLagMs, 'the value is kept, only flagged');

      backing.close();
      publisher.close();
      monitor.close();
    } finally {
      await server.stop();
    }
  });

  test('clears the calibration once the captured source is really gone', async () => {
    const server = await startRelay({ ...FAST, RELAY_BACKING_GRACE_MS: '300' });
    try {
      const { backing, publisher, monitor } = await liveSession(server);
      publisher.send(playingTelemetry);
      await primeStreams(backing, publisher);

      publisher.send({ type: 'start-timing-calibration' });
      await monitor.waitFor((m) => m.type === 'timing-calibration-status' && m.state === 'collecting');

      const { mic, backing: song } = laggedPair(8, RATE, 200);
      await Promise.all([
        sendPcmInChunks(backing, song),
        sendPcmInChunks(publisher, mic),
      ]);
      await monitor.waitFor((m) => m.type === 'timing-calibration-status' && m.state === 'complete', 10_000);

      backing.close();
      const cleared = await monitor.waitFor(
        (m) => m.type === 'source-status' && m.active === false,
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

  test('the microphone timeline survives a source socket reconnect', async () => {
    const server = await startRelay({ ...FAST, RELAY_BACKING_GRACE_MS: '5000' });
    try {
      const { backing, publisher, monitor } = await liveSession(server);

      await Promise.all([
        sendPcmInChunks(backing, tone(2, 0.8)),
        sendPcmInChunks(publisher, tone(2, 0.4)),
      ]);
      await monitor.waitForType('mix-health', 3_000);

      backing.close();
      await sleep(200);

      const rejoined = await RelayClient.connect(server);
      rejoined.newCaptureSession();
      rejoined.send({ type: 'register', role: 'backing', sampleRate: RATE });
      await rejoined.waitForType('registered');
      await sendPcmInChunks(rejoined, tone(1, 0.8));

      const health = await monitor.waitFor(
        (m) => m.type === 'mix-health' && m.active === true,
        3_000,
      );
      assert.equal(health.micGapMs, 0, 'the microphone timeline was never cleared');
      assert.equal(monitor.latest('source-status')?.active, true);

      rejoined.close();
      publisher.close();
      monitor.close();
    } finally {
      await server.stop();
    }
  });

  test('a source socket reconnect does not end the take', async () => {
    const server = await startRelay({ ...FAST, RELAY_BACKING_GRACE_MS: '5000' });
    try {
      const { backing, publisher, monitor } = await liveSession(server);
      publisher.send(playingTelemetry);
      await primeStreams(backing, publisher);

      publisher.send({ type: 'start-timing-calibration' });
      await monitor.waitFor((m) => m.type === 'timing-calibration-status' && m.state === 'collecting');

      const { mic, backing: song } = laggedPair(8, RATE, 200);
      await Promise.all([
        sendPcmInChunks(backing, song),
        sendPcmInChunks(publisher, mic),
      ]);
      const complete = await monitor.waitFor(
        (m) => m.type === 'timing-calibration-status' && m.state === 'complete',
        10_000,
      );

      const cursor = backing.cursor;
      const generation = backing.generationId;
      backing.close();
      await sleep(300);

      const rejoined = await RelayClient.connect(server);
      rejoined.resumeCaptureSession(generation, cursor + Math.round(RATE * 0.3));
      rejoined.send({ type: 'register', role: 'backing', sampleRate: RATE });
      await rejoined.waitForType('registered');
      await sendPcmInChunks(rejoined, tone(0.5, 0.8));
      await sleep(400);

      const after = monitor.latest('source-status');
      assert.equal(after?.active, true, 'the session must still be running');
      assert.equal(after?.calibratedMicLagMs, complete.micLagMs, 'the measurement still describes this setup');
      assert.equal(after?.calibrationStale, false);

      rejoined.close();
      publisher.close();
      monitor.close();
    } finally {
      await server.stop();
    }
  });
});