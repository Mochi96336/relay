import assert from 'node:assert/strict';
import test from 'node:test';

import { RelayClient, startRelay } from './helpers/harness.js';

function participantQuery(id: string, nickname: string) {
  const params = new URLSearchParams({ participant: id, name: nickname });
  return `?${params.toString()}`;
}

function uplinkHealth(generation: number, healthRequestId?: number) {
  return {
    type: 'audio-uplink-health',
    version: 1,
    captureGeneration: generation,
    ...(healthRequestId === undefined ? {} : { healthRequestId }),
    capturedSamples: 48_000,
    inputGapSamples: 0,
    inputMuted: false,
    capture: null,
    captureLevel: null,
    droppedSamples: {
      total: 0,
      disconnected: 0,
      congested: 0,
      packetTooLarge: 0,
    },
    controlReconnects: 0,
    transport: {
      path: 'websocket',
      maxPacketBytes: null,
      minWebTransportMaxPacketBytes: null,
      maxWebTransportMaxPacketBytes: null,
      datagramPacketBytesCeiling: null,
      datagramQueuePackets: null,
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
    },
  };
}

test('publisher health ACK echoes the browser request correlation id', async () => {
  const server = await startRelay({ RELAY_AUTO_CALIBRATE: '0', RELAY_HEARTBEAT_MS: '60000' });
  try {
    const publisher = await RelayClient.connect(
      server,
      participantQuery('publisher-health-correlation', 'Health Correlation'),
    );
    publisher.send({
      type: 'register',
      role: 'publisher',
      sampleRate: 48_000,
      captureGeneration: 17,
      audioPacketVersion: 2,
    });
    await publisher.waitForType('registered');

    publisher.send(uplinkHealth(17, 42));
    const correlated = await publisher.waitFor(
      (message) => message.type === 'audio-uplink-health-ack' && message.healthRequestId === 42,
    );
    assert.equal(correlated.captureGeneration, 17);

    publisher.send(uplinkHealth(17));
    const legacy = await publisher.waitFor(
      (message) => message.type === 'audio-uplink-health-ack' && message.healthRequestId === undefined,
    );
    assert.equal(legacy.captureGeneration, 17);

    publisher.close();
  } finally {
    await server.stop();
  }
});
