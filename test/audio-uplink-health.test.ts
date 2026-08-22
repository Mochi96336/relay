import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseAudioUplinkHealth } from '../src/audio-uplink-health.js';

function validHealth() {
  return {
    type: 'audio-uplink-health',
    version: 1,
    captureGeneration: 7,
    capturedSamples: 48_000,
    inputGapSamples: 128,
    droppedSamples: {
      total: 960,
      disconnected: 480,
      congested: 480,
      packetTooLarge: 0,
    },
    controlReconnects: 2,
    transport: {
      path: 'webtransport',
      maxPacketBytes: 1200,
      minWebTransportMaxPacketBytes: 1180,
      maxWebTransportMaxPacketBytes: 1200,
      webTransportAttempts: 2,
      webTransportConnections: 2,
      webTransportDemotions: 1,
      webTransportPacketsSubmitted: 100,
      webTransportCongestedRejects: 3,
      webTransportPacketTooLargeRejects: 1,
      webTransportSendFailures: 1,
      webSocketPacketsSent: 20,
      webSocketCongestedRejects: 0,
      webSocketDisconnectedRejects: 4,
      webSocketSendFailures: 0,
    },
  };
}

describe('audio uplink health', () => {
  it('accepts one cumulative capture-scoped telemetry snapshot', () => {
    const health = parseAudioUplinkHealth(validHealth());
    assert.ok(health);
    assert.equal(health.captureGeneration, 7);
    assert.equal(health.droppedSamples.total, 960);
    assert.equal(health.transport.path, 'webtransport');
    assert.equal(health.transport.minWebTransportMaxPacketBytes, 1180);
  });

  it('rejects inconsistent local drop accounting', () => {
    const input = validHealth();
    input.droppedSamples.total = 959;
    assert.equal(parseAudioUplinkHealth(input), null);
  });

  it('rejects malformed counters and reversed datagram bounds', () => {
    const negative = validHealth();
    negative.transport.webTransportDemotions = -1;
    assert.equal(parseAudioUplinkHealth(negative), null);

    const reversed = validHealth();
    reversed.transport.minWebTransportMaxPacketBytes = 1300;
    assert.equal(parseAudioUplinkHealth(reversed), null);
  });

  it('accepts WebSocket-only captures without a datagram budget', () => {
    const input: any = validHealth();
    input.transport.path = 'websocket';
    input.transport.maxPacketBytes = null;
    input.transport.minWebTransportMaxPacketBytes = null;
    input.transport.maxWebTransportMaxPacketBytes = null;
    const health = parseAudioUplinkHealth(input);
    assert.ok(health);
    assert.equal(health.transport.maxPacketBytes, null);
  });

  it('accepts a capture that predates the datagram ceiling field as unknown, not malformed', () => {
    const payload = validHealth();
    delete (payload.transport as Record<string, unknown>).datagramPacketBytesCeiling;

    const parsed = parseAudioUplinkHealth(payload);
    assert.notEqual(parsed, null, 'an older page must keep delivering its uplink evidence');
    assert.equal(parsed!.transport.datagramPacketBytesCeiling, null);
    assert.equal(parsed!.transport.webSocketPacketsSent, 20, 'the rest of the report survives');
  });

  it('still rejects a report whose datagram ceiling is present but nonsensical', () => {
    const payload = validHealth();
    (payload.transport as Record<string, unknown>).datagramPacketBytesCeiling = -1;

    assert.equal(parseAudioUplinkHealth(payload), null);
  });
});
