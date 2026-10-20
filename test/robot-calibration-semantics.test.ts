import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RelayClient,
  sendPcmInChunks,
  startRelay,
  waitForNewMessage,
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

test('Robot manual realignment starts boot-probe from fresh silent capture without YouTube telemetry', async () => {
  const server = await startRelay(ROBOT_FAST);
  try {
    const backing = await RelayClient.connectInfrastructure(server);
    backing.send({ type: 'register', role: 'backing', sampleRate: RATE, robot: true });
    await backing.waitForType('registered');

    const publisher = await RelayClient.connectAs(server, 'singer', 'Singer');
    publisher.send({ type: 'register', role: 'publisher', sampleRate: RATE });
    await publisher.waitForType('registered');

    const robot = await RelayClient.connectInfrastructure(server);
    robot.send({ type: 'robot-source-hello' });

    // Silence is intentional. "Streaming" here means both PCM sample timelines
    // are advancing with fresh frames, not that Song content is audible.
    const silentHalfSecond = Buffer.alloc(Math.round(RATE * 0.5) * 2);
    await Promise.all([
      sendPcmInChunks(backing, silentHalfSecond),
      sendPcmInChunks(publisher, silentHalfSecond),
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
