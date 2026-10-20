import assert from 'node:assert/strict';
import test from 'node:test';

import { RelayClient, sleep, startRelay } from './helpers/harness.js';
import { uplinkHealthReport } from './support/uplink-health.js';

function uplinkHealth(generation: number, transport: Record<string, unknown>) {
  return { type: 'audio-uplink-health', ...uplinkHealthReport(generation, 0, { transport }) };
}

async function micDeviceLine(server: Awaited<ReturnType<typeof startRelay>>) {
  for (let waited = 0; waited < 2_000; waited += 20) {
    const line = server.stdout().split('\n').find((entry) => entry.startsWith('[mic-device] '));
    if (line) return JSON.parse(line.slice('[mic-device] '.length));
    await sleep(20);
  }
  throw new Error('no [mic-device] line');
}

test('[mic-device] names the page build and codec behind a capture', async () => {
  const server = await startRelay({ RELAY_AUTO_CALIBRATE: '0', RELAY_HEARTBEAT_MS: '60000' });
  try {
    const publisher = await RelayClient.connectAs(server, 'device-log', 'Device');
    publisher.send({
      type: 'register',
      role: 'publisher',
      sampleRate: 48_000,
      captureGeneration: 7,
      audioPacketVersion: 2,
    });
    await publisher.waitForType('registered');
    publisher.send(uplinkHealth(7, { codec: 'pcm16', codecBitrate: 768_000 }));

    const line = await micDeviceLine(server);
    // A page that never sent its build predates sending it; that is the evidence.
    assert.equal(line.pageBuild, null);
    assert.match(line.relayBuild, /^[0-9a-f]{6,}$/);
    assert.equal(line.codec, 'pcm16');
    assert.equal(line.codecBitrate, 768_000);
    publisher.close();
  } finally {
    await server.stop();
  }
});
