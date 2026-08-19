import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RelayClient,
  sendPcmInChunks,
  sleep,
  startRelay,
} from './helpers/harness.js';

const RATE = 48_000;
const ROBOT_FAST = {
  RELAY_LIVE_PREBUFFER_MS: '200',
  RELAY_CALIBRATION_TIMEOUT_MS: '1500',
  RELAY_HEARTBEAT_MS: '60000',
  RELAY_AUTO_CALIBRATE: '0',
  RELAY_CALIBRATION_AGREEMENT: '1',
  RELAY_CALIBRATION_PROBE: '1',
  RELAY_CALIBRATION_PROBE_RETRY_MS: '100',
  RELAY_CALIBRATION_PROBE_LEAD_MS: '20',
  RELAY_CALIBRATION_PROBE_SEARCH_MARGIN_MS: '200',
  RELAY_CALIBRATION_PROBE_MIN_CORRELATION: '0',
  RELAY_CALIBRATION_PROBE_ANALYSIS_TIMEOUT_MS: '3000',
};

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

test('Robot manual realignment starts boot-probe from fresh silent capture without YouTube telemetry', async () => {
  const server = await startRelay(ROBOT_FAST);
  try {
    const backing = await RelayClient.connect(server);
    backing.send({ type: 'register', role: 'backing', sampleRate: RATE, robot: true });
    await backing.waitForType('registered');

    const publisher = await RelayClient.connect(server);
    publisher.send({ type: 'register', role: 'publisher', sampleRate: RATE });
    await publisher.waitForType('registered');

    const robot = await RelayClient.connect(server);
    robot.send({ type: 'robot-source-hello' });

    // Silence is intentional. "Streaming" here means both PCM sample timelines
    // are advancing with fresh frames, not that Song content is audible.
    await Promise.all([
      sendPcmInChunks(backing, new Int16Array(Math.round(RATE * 0.5))),
      sendPcmInChunks(publisher, new Int16Array(Math.round(RATE * 0.5))),
    ]);

    const from = publisher.messages.length;
    // No youtube-telemetry message is sent anywhere in this test.
    publisher.send({ type: 'start-timing-calibration' });

    const probe = await waitForNewMessage(
      publisher,
      from,
      (message) => message.type === 'play-calibration-probe' && message.target === 'mic',
      3_000,
    );

    assert.equal(probe.target, 'mic');

    backing.close();
    publisher.close();
    robot.close();
  } finally {
    await server.stop();
  }
});
