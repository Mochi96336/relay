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

      // A live take is not a test run. Clients that could not tell the two
      // apart ran every take in test mode, which cost the monitor 30 dB.
      assert.equal(monitor.latest('test-status')?.active, false, 'no test is running');
      assert.equal(monitor.latest('test-status')?.mode, 'off');

      const live = monitor.latest('source-status');
      assert.equal(live?.active, true, 'the live session describes itself');
      assert.equal(live?.mixSampleRate, RATE);

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

describe('framed pcm', () => {
  test('reports a hole when the uplink drops chunks, instead of pulling audio earlier', async () => {
    const server = await startRelay(FAST);
    try {
      const { backing, publisher, monitor } = await liveSession(server);

      await sendPcmInChunks(backing, tone(3, 0.8));

      // One second of microphone, then 400 ms captured but never sent, then
      // more. The cursor keeps advancing across the drop.
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

      // Before the fix the mixer stopped dead without a publisher, so the take
      // lost the song too, even though it was arriving perfectly well.
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

      // Same capture session: the phone kept recording through the outage, so
      // the cursor carries on and the server places the frames where they
      // belong rather than restarting the mix epoch.
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

  test('measures an injected lag and survives a socket-only reconnect', async () => {
    const server = await startRelay(FAST);
    try {
      const { backing, publisher, monitor } = await liveSession(server);
      publisher.send(playingTelemetry);
      await sleep(100);

      monitor.send({ type: 'start-timing-calibration' });
      await monitor.waitFor((m) => m.type === 'timing-calibration-status' && m.state === 'collecting');

      const lagMs = 260;
      const { mic, backing: song } = laggedPair(6, RATE, lagMs);
      // Concurrently, the way a real take streams. Sending one side to
      // completion first anchors its timeline that much earlier, and the
      // measurement now reports that skew instead of discarding it.
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

      // Only the socket died. The capture kept counting samples, so the
      // measurement still describes the same transport and must stay valid.
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
      await sleep(100);

      monitor.send({ type: 'start-timing-calibration' });
      await monitor.waitFor((m) => m.type === 'timing-calibration-status' && m.state === 'collecting');

      const { mic, backing: song } = laggedPair(6, RATE, 260);
      await sendPcmInChunks(backing, song);
      await sendPcmInChunks(publisher, mic);
      const complete = await monitor.waitFor(
        (m) => m.type === 'timing-calibration-status' && m.state === 'complete',
        10_000,
      );

      // The user pressed Microphone again: a different capture, so the delay
      // the measurement folded in may no longer hold.
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

  test('marks the measurement stale when the desktop player is seeked', async () => {
    const server = await startRelay(FAST);
    try {
      const { backing, publisher, monitor } = await liveSession(server);
      publisher.send(playingTelemetry);
      await sleep(100);

      monitor.send({ type: 'start-timing-calibration' });
      await monitor.waitFor((m) => m.type === 'timing-calibration-status' && m.state === 'collecting');

      const { mic, backing: song } = laggedPair(6, RATE, 260);
      await Promise.all([
        sendPcmInChunks(backing, song),
        sendPcmInChunks(publisher, mic),
      ]);
      const complete = await monitor.waitFor(
        (m) => m.type === 'timing-calibration-status' && m.state === 'complete',
        10_000,
      );
      assert.equal(complete.calibrationStale, false);

      // The follower corrected its mirrored player. It only does so past 450 ms
      // of error, so the song has moved somewhere arbitrary inside that band and
      // the measured offset no longer describes where it sits.
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
    // A short grace period, so the take survives a blip but a closed tab still
    // ends the session rather than leaving a dead one running.
    const server = await startRelay({ ...FAST, RELAY_BACKING_GRACE_MS: '300' });
    try {
      const { backing, publisher, monitor } = await liveSession(server);
      publisher.send(playingTelemetry);
      await sleep(100);

      monitor.send({ type: 'start-timing-calibration' });
      await monitor.waitFor((m) => m.type === 'timing-calibration-status' && m.state === 'collecting');

      const { mic, backing: song } = laggedPair(6, RATE, 200);
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

      // The desktop link blips. The phone did nothing wrong, and its audio must
      // not be thrown away for it - which is what restarting the session did.
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
      await sleep(100);

      monitor.send({ type: 'start-timing-calibration' });
      await monitor.waitFor((m) => m.type === 'timing-calibration-status' && m.state === 'collecting');

      const { mic, backing: song } = laggedPair(6, RATE, 200);
      await Promise.all([
        sendPcmInChunks(backing, song),
        sendPcmInChunks(publisher, mic),
      ]);
      const complete = await monitor.waitFor(
        (m) => m.type === 'timing-calibration-status' && m.state === 'complete',
        10_000,
      );

      // Only the socket died. The extension keeps capturing and reconnects on
      // its own, so its frames land back on the timeline they left - the same
      // contract the microphone already had.
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
