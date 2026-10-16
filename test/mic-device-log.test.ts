import assert from 'node:assert/strict';
import test from 'node:test';

import { RelayClient, sleep, startRelay } from './helpers/harness.js';

function uplinkHealth(generation: number, transport: Record<string, unknown>) {
  return {
    type: 'audio-uplink-health',
    version: 1,
    captureGeneration: generation,
    capturedSamples: 0,
    inputGapSamples: 0,
    inputMuted: false,
    droppedSamples: { total: 0, disconnected: 0, congested: 0, packetTooLarge: 0 },
    controlReconnects: 0,
    transport: {
      path: 'websocket',
      maxPacketBytes: null,
      minWebTransportMaxPacketBytes: null,
      maxWebTransportMaxPacketBytes: null,
      webTransportAttempts: 0,
      webTransportConnections: 0,
      webTransportDemotions: 0,
      webTransportPacketsSubmitted: 0,
      webTransportCongestedRejects: 0,
      webTransportPacketTooLargeRejects: 0,
      webTransportSendFailures: 0,
      webSocketPacketsSent: 0,
      webSocketCongestedRejects: 0,
      webSocketDisconnectedRejects: 0,
      webSocketSendFailures: 0,
      ...transport,
    },
  };
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
    const publisher = await RelayClient.connect(server, '?participant=device-log&name=Device');
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
