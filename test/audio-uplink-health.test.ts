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
    inputGapActive: false,
    inputMuted: false,
    capture: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      audioSessionType: 'play-and-record',
      inputLabel: 'iPhone Microphone',
      device: 'iPhone iOS 18.6 · Safari 26.0',
    },
    captureLevel: {
      peakDbfs: -18,
      rmsDbfs: -31,
    },
    captureClipping: {
      railSamples: 12,
      maxConsecutiveRailSamples: 6,
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
      inputLabel: 'iPhone Microphone',
      device: 'iPhone iOS 18.6 · Safari 26.0',
    });
    assert.deepEqual(health.captureLevel, { peakDbfs: -18, rmsDbfs: -31 });
    assert.deepEqual(health.captureClipping, {
      railSamples: 12,
      maxConsecutiveRailSamples: 6,
    });
  });

  it('keeps the page\'s WebTransport failure reason short and plain', () => {
    const health: any = validHealth();
    health.transport.webTransportLastFailure = 'connect:WebTransportError/session';
    assert.equal(parseAudioUplinkHealth(health)?.transport.webTransportLastFailure, 'connect:WebTransportError/session');
    health.transport.webTransportLastFailure = `setup:<b>${'x'.repeat(200)}`;
    const cleaned = parseAudioUplinkHealth(health)?.transport.webTransportLastFailure;
    assert.ok(cleaned && cleaned.length <= 64 && !/[<>]/.test(cleaned), String(cleaned));
    delete health.transport.webTransportLastFailure;
    assert.equal(parseAudioUplinkHealth(health)?.transport.webTransportLastFailure, null, 'older pages omit it');
  });

  it('accepts capture dispatch evidence and cumulative pre-transport drops', () => {
    const input: any = validHealth();
    input.captureDispatch = {
      lagMs: 240,
      maxLagMs: 620,
      backlogMs: 200,
      backlogActive: true,
    };
    input.droppedSamples.captureBacklog = 960;
    input.droppedSamples.total += 960;

    const health = parseAudioUplinkHealth(input);
    assert.ok(health);
    assert.deepEqual(health.captureDispatch, input.captureDispatch);
    assert.equal(health.droppedSamples.captureBacklog, 960);

    const malformed: any = structuredClone(input);
    malformed.captureDispatch.maxLagMs = 100;
    assert.equal(parseAudioUplinkHealth(malformed), null);
  });

  it('keeps active input-gap state rollout-compatible and strict when supplied', () => {
    const current = parseAudioUplinkHealth(validHealth());
    assert.ok(current);
    assert.equal(current.inputGapActive, false);
    assert.equal(current.inputGapActiveObserved, true);
    assert.equal(
      Object.prototype.propertyIsEnumerable.call(current, 'inputGapActiveObserved'),
      false,
    );
    assert.equal(JSON.stringify(current).includes('inputGapActiveObserved'), false);

    const active: any = validHealth();
    active.inputGapActive = true;
    assert.equal(parseAudioUplinkHealth(active)?.inputGapActive, true);

    const legacy: any = validHealth();
    delete legacy.inputGapActive;
    const parsedLegacy = parseAudioUplinkHealth(legacy);
    assert.ok(parsedLegacy);
    assert.equal(
      parsedLegacy.inputGapActive,
      false,
      'older health v1 remains parse-compatible until its page reloads onto active-gap telemetry',
    );
    assert.equal(parsedLegacy.inputGapActiveObserved, false);
    assert.equal(JSON.stringify(parsedLegacy).includes('inputGapActiveObserved'), false);

    for (const inputGapActive of ['false', 'true', 0, 1, null, {}, []]) {
      const malformed: any = validHealth();
      malformed.inputGapActive = inputGapActive;
      assert.equal(
        parseAudioUplinkHealth(malformed),
        null,
        `supplied inputGapActive must be boolean, got ${JSON.stringify(inputGapActive)}`,
      );
    }
  });

  it('keeps missing legacy inputMuted compatible but rejects malformed supplied values', () => {
    const legacy: any = validHealth();
    delete legacy.inputMuted;
    const parsedLegacy = parseAudioUplinkHealth(legacy);
    assert.ok(parsedLegacy);
    assert.equal(parsedLegacy.inputMuted, false);

    for (const inputMuted of ['false', 'true', 0, 1, null, {}, []]) {
      const malformed: any = validHealth();
      malformed.inputMuted = inputMuted;
      assert.equal(
        parseAudioUplinkHealth(malformed),
        null,
        `supplied inputMuted must be boolean, got ${JSON.stringify(inputMuted)}`,
      );
    }
  });

  it('tracks explicit mute-state provenance without changing the serialized health shape', () => {
    const current = parseAudioUplinkHealth(validHealth());
    assert.ok(current);
    assert.equal(current.inputMutedObserved, true);
    assert.equal(
      Object.prototype.propertyIsEnumerable.call(current, 'inputMutedObserved'),
      false,
    );
    assert.equal(JSON.stringify(current).includes('inputMutedObserved'), false);

    const legacy: any = validHealth();
    delete legacy.inputMuted;
    const parsedLegacy = parseAudioUplinkHealth(legacy);
    assert.ok(parsedLegacy);
    assert.equal(parsedLegacy.inputMuted, false);
    assert.equal(parsedLegacy.inputMutedObserved, false);
    assert.equal(JSON.stringify(parsedLegacy).includes('inputMutedObserved'), false);
  });

  it('preserves an optional uint32 health request correlation token', () => {
    const input: any = validHealth();
    input.healthRequestId = 0xffff_ffff;
    const health = parseAudioUplinkHealth(input);
    assert.ok(health);
    assert.equal(health.healthRequestId, 0xffff_ffff);
  });

  it('keeps health request correlation backward-compatible with older v1 pages', () => {
    const health = parseAudioUplinkHealth(validHealth());
    assert.ok(health);
    assert.equal(health.healthRequestId, undefined);
  });

  it('keeps terminal media-recovery telemetry backward-compatible with older v1 pages', () => {
    const legacy = parseAudioUplinkHealth(validHealth());
    assert.ok(legacy);
    assert.equal(legacy.transport.mediaRecoveryDegraded, false);

    const degraded: any = validHealth();
    degraded.transport.mediaRecoveryDegraded = true;
    const parsed = parseAudioUplinkHealth(degraded);
    assert.ok(parsed);
    assert.equal(parsed.transport.mediaRecoveryDegraded, true);

    const malformed: any = validHealth();
    malformed.transport.mediaRecoveryDegraded = 'true';
    assert.equal(parseAudioUplinkHealth(malformed), null);
  });

  it('rejects malformed supplied health request correlation tokens', () => {
    for (const healthRequestId of [-1, 0x1_0000_0000, 1.5, '7']) {
      const input: any = validHealth();
      input.healthRequestId = healthRequestId;
      assert.equal(parseAudioUplinkHealth(input), null);
    }
  });

  it('accepts recent clipping verdicts without requiring them from older v1 pages', () => {
    const current: any = validHealth();
    current.captureClipping.recentDetected = true;
    assert.deepEqual(parseAudioUplinkHealth(current)?.captureClipping, {
      railSamples: 12,
      maxConsecutiveRailSamples: 6,
      recentDetected: true,
    });

    const clean: any = validHealth();
    clean.captureClipping.recentDetected = false;
    assert.equal(parseAudioUplinkHealth(clean)?.captureClipping?.recentDetected, false);

    const legacy = parseAudioUplinkHealth(validHealth());
    assert.ok(legacy);
    assert.equal(legacy.captureClipping?.recentDetected, undefined);

    for (const recentDetected of ['true', 1, 0, null, {}, []]) {
      const malformed: any = validHealth();
      malformed.captureClipping.recentDetected = recentDetected;
      assert.equal(
        parseAudioUplinkHealth(malformed),
        null,
        `supplied recentDetected must be boolean, got ${JSON.stringify(recentDetected)}`,
      );
    }
  });

  it('keeps capture clipping optional for older v1 pages and rejects malformed rail evidence', () => {
    const legacy: any = validHealth();
    delete legacy.captureClipping;
    const parsedLegacy = parseAudioUplinkHealth(legacy);
    assert.ok(parsedLegacy);
    assert.equal(parsedLegacy.captureClipping, null);

    const explicitNull: any = validHealth();
    explicitNull.captureClipping = null;
    const parsedNull = parseAudioUplinkHealth(explicitNull);
    assert.ok(parsedNull);
    assert.equal(parsedNull.captureClipping, null);

    const impossible: any = validHealth();
    impossible.captureClipping = {
      railSamples: 2,
      maxConsecutiveRailSamples: 3,
    };
    assert.equal(parseAudioUplinkHealth(impossible), null);

    const negative: any = validHealth();
    negative.captureClipping = {
      railSamples: -1,
      maxConsecutiveRailSamples: 0,
    };
    assert.equal(parseAudioUplinkHealth(negative), null);

    const coerced: any = validHealth();
    coerced.captureClipping = {
      railSamples: '12',
      maxConsecutiveRailSamples: 6,
    };
    assert.equal(parseAudioUplinkHealth(coerced), null);
  });

  it('keeps the added capture facts backward-compatible with older v1 pages', () => {
    const input: any = validHealth();
    delete input.capture;
    delete input.captureLevel;
    delete input.captureClipping;
    const health = parseAudioUplinkHealth(input);
    assert.ok(health);
    assert.equal(health.capture, null);
    assert.equal(health.captureLevel, null);
    assert.equal(health.captureClipping, null);
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
    // A page from before the device fields omits them; they read as unknown.
    assert.deepEqual(health.capture, { ...input.capture, inputLabel: null, device: null });
    assert.equal(health.captureLevel, null);
  });

  it('keeps device names display-only: bounded, and never a reason to drop the report', () => {
    const long: any = validHealth();
    long.capture.inputLabel = `  ${'m'.repeat(100)}  `;
    long.capture.device = 'd'.repeat(200);
    const bounded = parseAudioUplinkHealth(long);
    assert.ok(bounded);
    assert.equal(bounded.capture?.inputLabel, 'm'.repeat(64));
    assert.equal(bounded.capture?.device, 'd'.repeat(96));

    const odd: any = validHealth();
    odd.capture.inputLabel = 42;
    odd.capture.device = '   ';
    const unknown = parseAudioUplinkHealth(odd);
    assert.ok(unknown, 'a malformed name must not cost the uplink facts beside it');
    assert.equal(unknown.capture?.inputLabel, null);
    assert.equal(unknown.capture?.device, null);
  });

  it('rejects malformed or unbounded applied settings instead of turning them into policy', () => {
    const input: any = validHealth();
    input.capture.echoCancellation = 'false';
    assert.equal(parseAudioUplinkHealth(input), null);

    const missing: any = validHealth();
    delete missing.capture.autoGainControl;
    assert.equal(parseAudioUplinkHealth(missing), null);

    const oversized: any = validHealth();
    oversized.capture.audioSessionType = 'x'.repeat(65);
    assert.equal(parseAudioUplinkHealth(oversized), null);

    const empty: any = validHealth();
    empty.capture.audioSessionType = '';
    assert.equal(parseAudioUplinkHealth(empty), null);
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


it('preserves optional sender monotonic sample timestamps and rejects malformed ones', () => {
  assert.equal(parseAudioUplinkHealth({ ...validHealth(), capturedAtPerformanceMs: 123.5 })?.capturedAtPerformanceMs, 123.5);
  assert.equal(parseAudioUplinkHealth(validHealth())?.capturedAtPerformanceMs, undefined);
  for (const capturedAtPerformanceMs of [-1, NaN, Infinity, '123']) {
    assert.equal(parseAudioUplinkHealth({ ...validHealth(), capturedAtPerformanceMs }), null);
  }
});
