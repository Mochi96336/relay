import assert from 'node:assert/strict';
import test from 'node:test';

import { RelayClient, sleep, startRelay } from './helpers/harness.js';

const RATE = 48_000;
const FRAME = Buffer.alloc(Math.round(RATE * 0.02) * 2);

const PROBE_FAST = {
  RELAY_AUTO_CALIBRATE: '0',
  RELAY_CALIBRATION_PROBE: '1',
  RELAY_CALIBRATION_PROBE_RETRY_MS: '100',
  RELAY_CALIBRATION_PROBE_REPLY_TIMEOUT_MS: '100',
  RELAY_CALIBRATION_PROBE_MAX_ATTEMPTS: '2',
  RELAY_CALIBRATION_PROBE_SEARCH_MARGIN_MS: '200',
  RELAY_CALIBRATION_PROBE_ANALYSIS_TIMEOUT_MS: '1500',
  RELAY_CALIBRATION_PROBE_MIN_CORRELATION: '0',
  RELAY_HEARTBEAT_MS: '60000',
};

async function robotSession(server: Awaited<ReturnType<typeof startRelay>>) {
  const backing = await RelayClient.connect(server);
  backing.send({ type: 'register', role: 'backing', sampleRate: RATE, robot: true });
  await backing.waitForType('registered');

  const publisher = await RelayClient.connect(server, '?participant=probe-singer&name=Singer');
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
    close() {
      clearInterval(keepFlowing);
      backing.close();
      publisher.close();
      robot.close();
      monitor.close();
    },
  };
}

async function waitForProbeCount(client: RelayClient, target: 'mic' | 'backing', count: number, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probes = client.messages.filter(
      (message) => message.type === 'play-calibration-probe' && message.target === target,
    );
    if (probes.length >= count) return probes;
    await sleep(20);
  }
  throw new Error(`Timed out waiting for ${count} ${target} probes`);
}

test('probe acknowledgement retries stop at the configured limit and block Take while active', async () => {
  const server = await startRelay(PROBE_FAST);
  const clients = await robotSession(server);
  try {
    const first = (await waitForProbeCount(clients.publisher, 'mic', 1))[0];
    assert.equal(first.target, 'mic');

    clients.publisher.send({ type: 'start-take' });
    const takeRejected = await clients.publisher.waitFor(
      (message) => message.type === 'take-command-rejected'
        && message.reason === 'timing-calibration-active',
      2_000,
    );
    assert.equal(takeRejected.reason, 'timing-calibration-active');

    const probes = await waitForProbeCount(clients.publisher, 'mic', 2);
    assert.notEqual(probes[0].requestId, probes[1].requestId);

    const failed = await clients.monitor.waitFor(
      (message) => message.type === 'timing-calibration-status'
        && message.state === 'failed'
        && message.probePhase === 'failed',
      3_000,
    );
    assert.equal(failed.probeActive, false);
    assert.equal(failed.probeAttempts.mic, 2);
    assert.equal(failed.probeMaxAttempts, 2);
    assert.match(failed.probeError, /Phone microphone timing probe failed after 2 attempts/);

    const countAtFailure = clients.publisher.messages.filter(
      (message) => message.type === 'play-calibration-probe' && message.target === 'mic',
    ).length;
    await sleep(700);
    const countAfterWait = clients.publisher.messages.filter(
      (message) => message.type === 'play-calibration-probe' && message.target === 'mic',
    ).length;
    assert.equal(countAfterWait, countAtFailure, 'terminal probe failure must not beep again automatically');
  } finally {
    clients.close();
    await server.stop();
  }
});

test('stale or wrong-generation acknowledgements cannot cancel the newer Mic probe request', async () => {
  const server = await startRelay({
    ...PROBE_FAST,
    RELAY_CALIBRATION_PROBE_MAX_ATTEMPTS: '3',
  });
  const clients = await robotSession(server);
  try {
    const first = (await waitForProbeCount(clients.publisher, 'mic', 1))[0];
    const probes = await waitForProbeCount(clients.publisher, 'mic', 2);
    const second = probes[1];
    const generation = clients.publisher.generationId;

    clients.publisher.send({
      type: 'calibration-probe-played',
      target: 'mic',
      requestId: first.requestId,
      generation,
    });
    await sleep(20);

    // Even with the current request id, a reply from a different capture must
    // not consume the request. The real phone reports captureGeneration from
    // its live AudioWorklet state rather than echoing the play request.
    clients.publisher.send({
      type: 'calibration-probe-played',
      target: 'mic',
      requestId: second.requestId,
      generation: generation + 1,
    });
    await sleep(20);

    clients.publisher.send({
      type: 'calibration-probe-played',
      target: 'mic',
      requestId: second.requestId,
      generation,
    });

    // Once the real current request is acknowledged, Relay must enter analysis.
    // With a third attempt available, either stale request ownership bug would
    // visibly emit probe #3 after the 100 ms reply timeout. Stay well below the
    // derived analysis timeout so detector/timeline behavior is out of scope.
    await sleep(450);
    const micProbes = clients.publisher.messages.filter(
      (message) => message.type === 'play-calibration-probe' && message.target === 'mic',
    );
    assert.equal(
      micProbes.length,
      2,
      'stale acknowledgement identity must not trigger another phone chime',
    );
  } finally {
    clients.close();
    await server.stop();
  }
});
