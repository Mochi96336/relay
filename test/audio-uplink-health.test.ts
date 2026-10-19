import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseAudioUplinkHealth } from '../src/audio-uplink-health.js';

it('preserves the actual Mic codec and bitrate in observation health', () => {
  const health = validHealth();
  const parsed = parseAudioUplinkHealth({ ...health,
    transport: { ...health.transport, codec: 'opus', codecBitrate: 128000, codecBitrateReason: 'stable-delivery' } });
  assert.equal(parsed?.transport.codec, 'opus');
  assert.equal(parsed?.transport.codecBitrate, 128000);
  assert.equal(parsed?.transport.codecBitrateReason, 'stable-delivery');
});

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

it('accepts staged capture clocks without accepting arbitrary or invalid clock data', () => {
  const captureClock = { contextSeconds: 12.2, originContextSeconds: 2,
    lastChunkContextSeconds: 12.18, lastChunkSampleIndex: 480000,
    lastChunkObservedAtMs: 14000, sampleRate: 48000 };
  assert.deepEqual(parseAudioUplinkHealth({ ...validHealth(), captureClock })?.captureClock, captureClock);
  assert.equal(parseAudioUplinkHealth(validHealth())?.captureClock, undefined);
  for (const bad of [NaN, -1, '12', Infinity]) {
    assert.equal(parseAudioUplinkHealth({ ...validHealth(), captureClock: { ...captureClock, contextSeconds: bad } }), null);
  }
  const startup = Object.fromEntries(Object.keys(captureClock).map(key => [key, null]));
  assert.deepEqual(parseAudioUplinkHealth({ ...validHealth(), captureClock: startup })?.captureClock, startup);
});

it('retains capture restart provenance while accepting legacy reports and rejecting malformed reasons', () => {
  assert.equal(parseAudioUplinkHealth(validHealth())?.captureGenerationReason, undefined);
  for (const reason of ['publisher-start', 'context-clock-underfed', 'input-gap', 'processor-error']) {
    const parsed = parseAudioUplinkHealth({ ...validHealth(), captureGenerationReason: reason });
    assert.equal(parsed?.captureGenerationReason, reason);
    assert.equal(parsed?.captureGeneration, 7);
  }
  for (const reason of ['', null, 7, {}, 'x'.repeat(65), 'input\ngap']) {
    assert.equal(parseAudioUplinkHealth({ ...validHealth(), captureGenerationReason: reason }), null);
  }
});

describe('media recovery evidence', () => {
  it('preserves bounded action evidence and explicit unknown timing', () => {
    const input: any = validHealth();
    input.transport.recovery = {sequence:1,action:'replace-websocket',reason:'control-ack-timeout',
      phase:'reconnect-proving',webTransportDemotionUsed:false,webSocketReplacementUsed:true,
      ackRoundTripMs:null,controlSilenceMs:6000,audioBacklogMs:null,queueAgeMs:0,pendingHealth:6,unmatchedHealthAcks:0};
    assert.deepEqual(parseAudioUplinkHealth(input)?.transport.recovery, input.transport.recovery);
    input.transport.recovery.pendingHealth = 65;
    assert.equal(parseAudioUplinkHealth(input), null);
    input.transport.recovery.pendingHealth = 6;
    input.transport.recovery.reason = '<bad>';
    assert.equal(parseAudioUplinkHealth(input), null);
    delete input.transport.recovery;
    assert.equal(parseAudioUplinkHealth(input)?.transport.recovery, undefined);
  });
});

it('recovery history rejects unbounded or non-monotonic events and keeps negative Mixer headroom', () => {
  const input: any = validHealth();
  input.transport.recovery = {sequence:2,action:'degraded-latched',reason:'control-ack-timeout-after-bounded-recovery',
    phase:'degraded-latched',webTransportDemotionUsed:false,webSocketReplacementUsed:true,
    ackRoundTripMs:null,controlSilenceMs:7000,audioBacklogMs:null,queueAgeMs:0,pendingHealth:7,unmatchedHealthAcks:0,
    mixPlayable:false,mixHeadroomMs:-300,events:[{sequence:1,action:'replace-websocket',reason:'control-ack-timeout'},
      {sequence:2,action:'degraded-latched',reason:'control-ack-timeout-after-bounded-recovery'}]};
  assert.equal(parseAudioUplinkHealth(input)?.transport.recovery?.mixHeadroomMs, -300);
  input.transport.recovery.events[1].sequence = 1;
  assert.equal(parseAudioUplinkHealth(input), null);
  input.transport.recovery.events = Array(9).fill({sequence:1,action:'recovered',reason:'test'});
  assert.equal(parseAudioUplinkHealth(input), null);
});

it('compact health preserves capture clocks, recovery and legacy parser validation', async () => {
  const { encodeAudioUplinkHealth, decodeAudioUplinkHealth } = await import('../shared/audio-uplink-health-wire.js');
  const input: any = validHealth();
  input.healthRequestId = 42;
  input.captureGenerationReason = 'start';
  input.capturedAtPerformanceMs = 12345.6789;
  input.captureClock = { contextSeconds: 2.123456789, originContextSeconds: 0,
    lastChunkContextSeconds: 2.1, lastChunkSampleIndex: 48000,
    lastChunkObservedAtMs: 12344.12, sampleRate: 48000 };
  input.captureDispatch = { lagMs: 20, maxLagMs: 50, backlogMs: 200, backlogActive: false };
  const wire = JSON.parse(encodeAudioUplinkHealth(input));
  assert.deepEqual(decodeAudioUplinkHealth(wire), input);
  assert.ok(parseAudioUplinkHealth(input));
  assert.deepEqual(parseAudioUplinkHealth(wire), parseAudioUplinkHealth(input));
  input.droppedSamples.total++;
  assert.equal(parseAudioUplinkHealth(JSON.parse(encodeAudioUplinkHealth(input))), null,
    'compaction must not bypass normal semantic validation');
  for (const bad of [ { ...wire, compact: 2 }, { ...wire, data: [-1] },
    { ...wire, data: [2 ** 40] }, { ...wire, data: wire.data.slice(0, -1) },
    { ...wire, data: [...wire.data, 123] } ]) assert.equal(parseAudioUplinkHealth(bad), null);
});

it('full compressed health leaves room for voice and ACK correlation at every trial bitrate', async () => {
  const { PreferredAudioTransport } = await import(new URL('../public/audio-transport.js', import.meta.url).href);
  for (const bitrate of [32000, 64000, 128000]) for (const longNames of [false, true]) {
    const sent: any[] = [];
    const socket = { readyState: 1, bufferedAmount: 0, send(data: any) {
      sent.push(data);
      this.bufferedAmount += typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
    } };
    const sender = new PreferredAudioTransport();
    sender.bind(socket, { sampleRate: 48000 });
    sender.fallback.setEncodedBitrate(bitrate);
    const input: any = { ...validHealth(), healthRequestId: 42,
      capturedAtPerformanceMs: 12345.6789,
      captureClock: { contextSeconds: 12345.123456789, originContextSeconds: 12.123456789,
        lastChunkContextSeconds: 12345.1, lastChunkSampleIndex: 48000,
        lastChunkObservedAtMs: 12344.123456789, sampleRate: 48000 },
      captureDispatch: { lagMs: 20, maxLagMs: 50,
        backlogMs: 200, backlogActive: false },
      transport: { ...sender.stats(), codec: 'opus', codecBitrate: bitrate,
        codecBitrateReason: 'stable-delivery' } };
    if (longNames) { input.capture.inputLabel = '麥'.repeat(64); input.capture.device = '機'.repeat(96); }
    input.transport.recovery = { ...input.transport.recovery, sequence: 8,
      events: Array.from({ length: 8 }, (_, i) => ({ sequence: i + 1,
        action: 'replace-websocket', reason: 'a'.repeat(90), ageMs: 123456.789 })) };
    const original = structuredClone(input);
    assert.ok(parseAudioUplinkHealth(input), 'fixture must match the actual server contract');
    assert.equal(sender.sendControlJson(input).sent, true, `${bitrate}: health must remain sendable`);
    const parsed = parseAudioUplinkHealth(JSON.parse(sent[0]));
    assert.ok(parsed);
    assert.equal(parsed.healthRequestId, 42);
    assert.equal(parsed.captureGeneration, input.captureGeneration);
    assert.equal(sender.pendingPublisherHealth.length, 1);
    sender.observePublisherSocketMessage(socket, sender.publisherSocketEpoch, { data: JSON.stringify({
      type: 'audio-uplink-health-ack', version: 1, captureGeneration: parsed.captureGeneration, healthRequestId: parsed.healthRequestId, pcm: { acceptedFrameSerial: 0 },
    }) });
    assert.equal(sender.pendingPublisherHealth.length, 0, 'compact request ID must match its ACK');
    assert.equal(parsed.transport.codecBitrate, bitrate);
    assert.deepEqual(parsed.captureClock, input.captureClock);
    assert.deepEqual(input, original, 'wire fitting cannot alter ACK/recovery bookkeeping');
    const frameBytes = Math.ceil(bitrate / 8 / 50) + 28;
    assert.equal(sender.fallback.send(new Uint8Array(frameBytes)).sent, true,
      `${bitrate}: immediately following voice frame must fit the physical FIFO`);
    assert.ok(socket.bufferedAmount <= sender.fallback.maxBufferedBytes);
    const writes = sent.length;
    assert.equal(sender.fallback.send('x'.repeat(16384), { control: true }).sent, false);
    assert.equal(sent.length, writes, 'rejected control must not enter the browser queue');
    sender.close();
  }
});

it('preserves optional repair diagnostics and rejects malformed values without inventing legacy history', () => {
  const legacy = parseAudioUplinkHealth(validHealth())!;
  assert.equal(legacy.transport.retransmitCacheMisses,undefined);
  assert.equal(legacy.transport.retransmitSendRejects,undefined);
  const input:any = validHealth();
  input.transport.retransmitCacheMisses=12;
  input.transport.retransmitSendRejects=3;
  const parsed=parseAudioUplinkHealth(input)!;
  assert.equal(parsed.transport.retransmitCacheMisses,12);
  assert.equal(parsed.transport.retransmitSendRejects,3);
  for(const key of ['retransmitCacheMisses','retransmitSendRejects']) {
    for(const value of [-1,1.5,'invalid',Number.MAX_SAFE_INTEGER+1]) {
      const invalid:any=validHealth();invalid.transport[key]=value;
      assert.equal(parseAudioUplinkHealth(invalid),null,`${key}: ${value}`);
    }
  }
});
