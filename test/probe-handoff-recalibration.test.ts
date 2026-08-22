import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RelayClient,
  laggedPair,
  sendPcmInChunks,
  sleep,
  startRelay,
  type RelayServer,
} from './helpers/harness.js';

const RATE = 48_000;
const FRAME = Buffer.alloc(Math.round(RATE * 0.02) * 2);
const FIRST_SINGER = 'probe-singer';
const SECOND_SINGER = 'probe-second';

/**
 * Probe timings compressed to milliseconds. The robot route is what makes the
 * two-leg boot probe the only calibration path, so every test here runs with
 * `robot: true` backing plus a robot source.
 */
const PROBE_FAST = {
  RELAY_CALIBRATION_PROBE: '1',
  RELAY_CALIBRATION_PROBE_RETRY_MS: '100',
  RELAY_CALIBRATION_PROBE_REPLY_TIMEOUT_MS: '100',
  RELAY_CALIBRATION_PROBE_MAX_ATTEMPTS: '2',
  RELAY_CALIBRATION_PROBE_SEARCH_MARGIN_MS: '200',
  RELAY_CALIBRATION_PROBE_ANALYSIS_TIMEOUT_MS: '1500',
  RELAY_CALIBRATION_PROBE_MIN_CORRELATION: '0',
  RELAY_HEARTBEAT_MS: '60000',
};

/**
 * Telemetry rejection is silent from the sender's side - the refusal arrives as
 * its own message rather than as an error on the send - so `assertTimelinePlaying`
 * checks the timeline really came up. Without that check a refused payload turns
 * the gate assertion below into a vacuous pass.
 */
const playingTelemetry = {
  type: 'youtube-telemetry',
  videoId: 'dQw4w9WgXcQ',
  state: 1,
  currentTime: 42,
  duration: 200,
  playbackRate: 1,
  networkRttMs: 40,
};

type RobotSession = {
  backing: RelayClient;
  publisher: RelayClient;
  robot: RelayClient;
  monitor: RelayClient;
  stopFlowing: () => void;
  close: () => void;
};

/**
 * `identified: false` connects the publisher without participant identity.
 *
 * An identified socket's telemetry is refused with `command-required` until a
 * room-song command loads the video, while the legacy path accepts it directly.
 * Handoff tests need real participants; the content-fallback test needs a
 * connected timeline and no handoff, so it takes the legacy path instead of
 * dragging the whole room-song command flow into a calibration test.
 */
async function robotSession(
  server: RelayServer,
  { identified = true }: { identified?: boolean } = {},
): Promise<RobotSession> {
  const backing = await RelayClient.connect(server);
  backing.send({ type: 'register', role: 'backing', sampleRate: RATE, robot: true });
  await backing.waitForType('registered');

  const publisher = await RelayClient.connect(
    server,
    identified ? `?participant=${FIRST_SINGER}&name=Singer` : '',
  );
  publisher.send({ type: 'register', role: 'publisher', sampleRate: RATE });
  await publisher.waitForType('registered');

  const robot = await RelayClient.connect(server);
  robot.send({ type: 'robot-source-hello' });

  const monitor = await RelayClient.connect(server);
  monitor.send({ type: 'register', role: 'monitor' });
  await monitor.waitForType('registered');

  const keepFlowing = setInterval(() => {
    backing.sendPcm(FRAME);
    publisher.sendPcm(FRAME);
  }, 50);
  backing.sendPcm(FRAME);
  publisher.sendPcm(FRAME);

  return {
    backing,
    publisher,
    robot,
    monitor,
    stopFlowing() {
      clearInterval(keepFlowing);
    },
    close() {
      clearInterval(keepFlowing);
      backing.close();
      publisher.close();
      robot.close();
      monitor.close();
    },
  };
}

function micProbes(client: RelayClient) {
  return client.messages.filter(
    (message) => message.type === 'play-calibration-probe' && message.target === 'mic',
  );
}

/**
 * Proves the room is actually eligible for content calibration before any test
 * concludes that content calibration did not happen. A rejected telemetry
 * payload or a starved stream would otherwise satisfy the same assertion for
 * entirely the wrong reason.
 */
async function assertTimelinePlaying(monitor: RelayClient) {
  const from = monitor.messages.length;
  monitor.send({ type: 'youtube-timeline-request' });
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const status = monitor.messages
      .slice(from)
      .find((message) => message.type === 'youtube-timeline-status');
    if (status?.connected === true && Number(status.state) === 1) return status;
    await sleep(20);
    monitor.send({ type: 'youtube-timeline-request' });
  }
  throw new Error('Timeline never reported a connected playing state');
}

function assertNoContentCalibration(monitor: RelayClient, fromIndex: number) {
  // `maybeAutoCalibrate` sets calibrationKind to 'content' immediately before
  // starting the session, so that value on any status is the signal - not just
  // a collecting state, which the probe path also produces.
  const contentRun = monitor.messages
    .slice(fromIndex)
    .find((message) => message.type === 'timing-calibration-status'
      && message.calibrationKind === 'content');
  assert.equal(
    contentRun,
    undefined,
    'content calibration is gated off for the whole robot route, not just while the probe is viable',
  );
}

async function waitForMicProbeCount(client: RelayClient, count: number, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probes = micProbes(client);
    if (probes.length >= count) return probes;
    await sleep(20);
  }
  throw new Error(`Timed out waiting for ${count} mic probes`);
}

test('a Mic handoff probes the new phone instead of reusing the old capture timing', async () => {
  const server = await startRelay({ ...PROBE_FAST, RELAY_AUTO_CALIBRATE: '0' });
  const clients = await robotSession(server);
  let second: RelayClient | null = null;
  let secondFlowing: NodeJS.Timeout | null = null;
  try {
    await waitForMicProbeCount(clients.publisher, 1);
    const beforeHandoff = micProbes(clients.publisher).length;

    // A handoff is a different participant registering as publisher while
    // naming the owner it expects to take over from. `Lmic` belongs to the
    // phone that measured it, so the new owner must not inherit it.
    clients.stopFlowing();
    second = await RelayClient.connect(server, `?participant=${SECOND_SINGER}&name=Second`);
    second.send({
      type: 'register',
      role: 'publisher',
      sampleRate: RATE,
      takeoverExpectedOwnerId: FIRST_SINGER,
    });
    await second.waitForType('registered');

    const handedOver = second;
    secondFlowing = setInterval(() => {
      clients.backing.sendPcm(FRAME);
      handedOver.sendPcm(FRAME);
    }, 50);
    clients.backing.sendPcm(FRAME);
    handedOver.sendPcm(FRAME);

    const probes = await waitForMicProbeCount(handedOver, 1);
    assert.equal(probes[0].target, 'mic');

    assert.equal(
      micProbes(clients.publisher).length,
      beforeHandoff,
      'the retired publisher must not be asked to beep for the new owner',
    );
  } finally {
    if (secondFlowing) clearInterval(secondFlowing);
    second?.close();
    clients.close();
    await server.stop();
  }
});

test('a Mic handoff discards the previous acoustic calibration', async () => {
  const server = await startRelay({ ...PROBE_FAST, RELAY_AUTO_CALIBRATE: '0' });
  const clients = await robotSession(server);
  let second: RelayClient | null = null;
  try {
    await waitForMicProbeCount(clients.publisher, 1);

    clients.stopFlowing();
    second = await RelayClient.connect(server, `?participant=${SECOND_SINGER}&name=Second`);
    second.send({
      type: 'register',
      role: 'publisher',
      sampleRate: RATE,
      takeoverExpectedOwnerId: FIRST_SINGER,
    });
    await second.waitForType('registered');

    clients.monitor.send({ type: 'timing-calibration-status-request' });
    const status = await clients.monitor.waitFor(
      (message) => message.type === 'timing-calibration-status',
      3_000,
    );
    assert.equal(
      status.timingMode,
      'network-estimate',
      'a handoff must not leave the previous phone\'s measured lag applied',
    );
  } finally {
    second?.close();
    clients.close();
    await server.stop();
  }
});

/**
 * The robot route prefers its two-leg probe because that probe is unambiguous
 * by construction. That preference is only meaningful while the probe can still
 * deliver: once it has spent its attempts, holding the gate shut means choosing
 * nothing over an ambiguous-but-real content correlation.
 *
 * Re-arming the probe was the other candidate and was rejected on product
 * grounds - its chime plays from the singer's own phone, so a mid-session retry
 * presents an internal recovery as an audible fault. Song content is already
 * playing and costs nobody a sound.
 *
 * Content calibration needs a playing song, which is exactly when alignment
 * matters: with no song, `delta` and `Lbacking` do not reach the mix at all.
 */
test('content calibration takes over once the probe has spent its attempts', async () => {
  const server = await startRelay({
    ...PROBE_FAST,
    RELAY_AUTO_CALIBRATE: '1',
    RELAY_AUTO_CALIBRATION_RETRY_MS: '100',
    RELAY_CALIBRATION_AGREEMENT: '1',
    RELAY_CALIBRATION_TIMEOUT_MS: '5000',
  });
  const clients = await robotSession(server, { identified: false });
  try {
    // Never acknowledge, so both attempts time out and the run goes terminal.
    const failed = await clients.monitor.waitFor(
      (message) => message.type === 'timing-calibration-status'
        && message.state === 'failed'
        && message.probePhase === 'failed',
      6_000,
    );
    assert.equal(failed.probeAttempts.mic, 2);
    assert.equal(failed.timingMode, 'network-estimate');

    clients.stopFlowing();
    clients.publisher.send(playingTelemetry);
    const pair = laggedPair(8, RATE, 260, 7);
    await Promise.all([
      sendPcmInChunks(clients.backing, pair.backing),
      sendPcmInChunks(clients.publisher, pair.mic),
    ]);

    const keepEligible = setInterval(() => {
      clients.backing.sendPcm(FRAME);
      clients.publisher.sendPcm(FRAME);
      clients.publisher.send(playingTelemetry);
    }, 50);

    try {
      await assertTimelinePlaying(clients.monitor);

      const started = await clients.monitor.waitFor(
        (message) => message.type === 'timing-calibration-status'
          && message.calibrationKind === 'content',
        6_000,
      );
      assert.equal(
        started.calibrationKind,
        'content',
        'a spent probe must hand the room to song-content timing, not to nothing',
      );
    } finally {
      clearInterval(keepEligible);
    }
  } finally {
    clients.close();
    await server.stop();
  }
});
