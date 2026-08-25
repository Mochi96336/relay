import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseAudioUplinkHealth } from '../src/audio-uplink-health.js';

function healthPayload() {
  return {
    type: 'audio-uplink-health',
    version: 1,
    captureGeneration: 3,
    capturedSamples: 96_000,
    inputGapSamples: 0,
    inputMuted: false,
    droppedSamples: {
      total: 0,
      disconnected: 0,
      congested: 0,
      packetTooLarge: 0,
    },
    controlReconnects: 0,
    transport: {
      path: 'webtransport',
      maxPacketBytes: 1000,
      minWebTransportMaxPacketBytes: 65_535,
      maxWebTransportMaxPacketBytes: 65_535,
      datagramPacketBytesCeiling: 1000,
      datagramQueuePackets: 4,
      webTransportAttempts: 1,
      webTransportConnections: 1,
      webTransportDemotions: 0,
      webTransportPacketsSubmitted: 100,
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

describe('WebTransport uplink health fields', () => {
  it('keeps browser raw maxDatagramSize separate from Relay applied limits', () => {
    const parsed = parseAudioUplinkHealth(healthPayload());
    assert.ok(parsed);
    assert.equal(parsed.transport.minWebTransportMaxPacketBytes, 65_535);
    assert.equal(parsed.transport.maxWebTransportMaxPacketBytes, 65_535);
    assert.equal(parsed.transport.maxPacketBytes, 1000);
    assert.equal(parsed.transport.datagramPacketBytesCeiling, 1000);
    assert.equal(parsed.transport.datagramQueuePackets, 4);
  });

  it('keeps older v1 payloads compatible when the Relay-applied fields are absent', () => {
    const payload = healthPayload();
    delete (payload.transport as Record<string, unknown>).datagramPacketBytesCeiling;
    delete (payload.transport as Record<string, unknown>).datagramQueuePackets;

    const parsed = parseAudioUplinkHealth(payload);
    assert.ok(parsed);
    assert.equal(parsed.transport.datagramPacketBytesCeiling, null);
    assert.equal(parsed.transport.datagramQueuePackets, null);
    assert.equal(parsed.transport.maxWebTransportMaxPacketBytes, 65_535);
  });

  it('rejects malformed Relay-applied limits without rewriting browser evidence', () => {
    const badCeiling = healthPayload();
    (badCeiling.transport as Record<string, unknown>).datagramPacketBytesCeiling = 0;
    assert.equal(parseAudioUplinkHealth(badCeiling), null);

    const badQueue = healthPayload();
    (badQueue.transport as Record<string, unknown>).datagramQueuePackets = -1;
    assert.equal(parseAudioUplinkHealth(badQueue), null);
  });
});
