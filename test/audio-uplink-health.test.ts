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
    inputMuted: false,
    capture: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      audioSessionType: 'play-and-record',
    },
    captureLevel: {
      peakDbfs: -18,
      rmsDbfs: -31,
    },
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
    assert.deepEqual(health.capture, {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      audioSessionType: 'play-and-record',
    });
    assert.deepEqual(health.captureLevel, { peakDbfs: -18, rmsDbfs: -31 });
  });

  it('keeps the added capture facts backward-compatible with older v1 pages', () => {
    const input: any = validHealth();
    delete input.capture;
    delete input.captureLevel;
    const health = parseAudioUplinkHealth(input);
    assert.ok(health);
    assert.equal(health.capture, null);
    assert.equal(health.captureLevel, null);
  });

  it('accepts explicit nulls for unsupported browser capture facts', () => {
    const input: any = validHealth();
    input.capture = {
      echoCancellation: null,
      noiseSuppression: null,
      autoGainControl: null,
      audioSessionType: null,
    };
    input.captureLevel = null;
    const health = parseAudioUplinkHealth(input);
    assert.ok(health);
    assert.deepEqual(health.capture, input.capture);
    assert.equal(health.captureLevel, null);
  });

  it('rejects malformed applied settings instead of turning them into policy', () => {
    const input: any = validHealth();
    input.capture.echoCancellation = 'false';
    assert.equal(parseAudioUplinkHealth(input), null);

    const missing: any = validHealth();
    delete missing.capture.autoGainControl;
    assert.equal(parseAudioUplinkHealth(missing), null);
  });

  it('rejects malformed or physically inconsistent worklet levels', () => {
    const positive: any = validHealth();
    positive.captureLevel.peakDbfs = 1;
    assert.equal(parseAudioUplinkHealth(positive), null);

    const impossible: any = validHealth();
    impossible.captureLevel = { peakDbfs: -30, rmsDbfs: -20 };
    assert.equal(parseAudioUplinkHealth(impossible), null);

    const infinite: any = validHealth();
    infinite.captureLevel = { peakDbfs: -20, rmsDbfs: Number.NEGATIVE_INFINITY };
    assert.equal(parseAudioUplinkHealth(infinite), null);

    const coerced: any = validHealth();
    coerced.captureLevel = { peakDbfs: '-18', rmsDbfs: '-31' };
    assert.equal(parseAudioUplinkHealth(coerced), null);
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
});