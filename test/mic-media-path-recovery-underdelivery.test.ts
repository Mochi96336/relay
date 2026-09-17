import assert from 'node:assert/strict';
import test from 'node:test';

import { MicMediaPathRecovery } from '../public/mic-media-path-recovery.js';

type Path = 'webtransport' | 'websocket';

type CoverageObservation = {
  captureGeneration: number;
  capturedSamples: number;
  captureSampleRate: number;
  serverAcceptedFrameSerial: number;
  serverAcceptedSampleCount: number;
  serverAcceptedSampleRate: number;
  serverMediaPath: Path | null;
  path: Path;
  socketEpoch: number;
  eligible: boolean;
};

function observation(overrides: Partial<CoverageObservation> = {}): CoverageObservation {
  return {
    captureGeneration: 7,
    capturedSamples: 0,
    captureSampleRate: 48_000,
    serverAcceptedFrameSerial: 0,
    serverAcceptedSampleCount: 0,
    serverAcceptedSampleRate: 48_000,
    serverMediaPath: 'webtransport',
    path: 'webtransport',
    socketEpoch: 1,
    eligible: true,
    ...overrides,
  };
}

function observe(recovery: MicMediaPathRecovery, input: CoverageObservation) {
  return recovery.observe(input as any);
}

test('three correlated majority-loss windows demote WebTransport even while accepted serial advances', () => {
  const recovery = new MicMediaPathRecovery();
  assert.equal(observe(recovery, observation()).reason, 'baseline');

  let decision;
  for (let second = 1; second <= 3; second += 1) {
    decision = observe(recovery, observation({
      capturedSamples: second * 48_000,
      serverAcceptedFrameSerial: second,
      // ~3.3% of the captured second reaches AudioSession. The serial still
      // advances, which is exactly the trickle failure class proven by #314.
      serverAcceptedSampleCount: second * 1_600,
    }));
  }

  assert.equal(decision?.action, 'demote-webtransport');
  assert.equal(decision?.reason, 'server-pcm-under-delivered');
  assert.equal(decision?.webTransportQuarantined, true);
});

test('coverage compares durations so healthy 44.1 kHz capture is not penalized by the 48 kHz mix rate', () => {
  const recovery = new MicMediaPathRecovery();
  observe(recovery, observation({
    captureSampleRate: 44_100,
    serverAcceptedSampleRate: 48_000,
  }));

  for (let second = 1; second <= 5; second += 1) {
    const decision = observe(recovery, observation({
      captureSampleRate: 44_100,
      capturedSamples: second * 44_100,
      serverAcceptedFrameSerial: second,
      serverAcceptedSampleRate: 48_000,
      serverAcceptedSampleCount: second * 48_000,
    }));
    assert.equal(decision.action, 'none');
    assert.equal(decision.reason, 'server-pcm-advancing');
    assert.equal(decision.staleObservations, 0);
  }
});

test('exactly half delivery stays inside the conservative floor', () => {
  const recovery = new MicMediaPathRecovery();
  observe(recovery, observation());

  for (let second = 1; second <= 4; second += 1) {
    const decision = observe(recovery, observation({
      capturedSamples: second * 48_000,
      serverAcceptedFrameSerial: second,
      serverAcceptedSampleCount: second * 24_000,
    }));
    assert.equal(decision.action, 'none');
    assert.equal(decision.staleObservations, 0);
  }
});

test('sparse WebSocket trickle cannot prove recovery after WebTransport demotion', () => {
  const recovery = new MicMediaPathRecovery();
  observe(recovery, observation());

  let captured = 0;
  let accepted = 0;
  let serial = 0;
  for (let second = 1; second <= 3; second += 1) {
    captured += 48_000;
    accepted += 1_600;
    serial += 1;
    const decision = observe(recovery, observation({
      capturedSamples: captured,
      serverAcceptedFrameSerial: serial,
      serverAcceptedSampleCount: accepted,
    }));
    if (second < 3) assert.equal(decision.action, 'none');
    else assert.equal(decision.action, 'demote-webtransport');
  }

  captured += 48_000;
  accepted += 1_600;
  serial += 1;
  const baseline = observe(recovery, observation({
    capturedSamples: captured,
    serverAcceptedFrameSerial: serial,
    serverAcceptedSampleCount: accepted,
    serverMediaPath: 'websocket',
    path: 'websocket',
  }));
  assert.equal(baseline.reason, 'server-websocket-rebaseline');

  let decision;
  for (let second = 1; second <= 3; second += 1) {
    captured += 48_000;
    accepted += 1_600;
    serial += 1;
    decision = observe(recovery, observation({
      capturedSamples: captured,
      serverAcceptedFrameSerial: serial,
      serverAcceptedSampleCount: accepted,
      serverMediaPath: 'websocket',
      path: 'websocket',
    }));
  }

  assert.equal(decision?.action, 'replace-websocket');
  assert.equal(decision?.reason, 'server-pcm-under-delivered-after-fallback');
});

test('a healthy WebSocket coverage window proves recovery after the server-path baseline', () => {
  const recovery = new MicMediaPathRecovery({ staleObservations: 1 });
  observe(recovery, observation());
  assert.equal(observe(recovery, observation({
    capturedSamples: 48_000,
    serverAcceptedFrameSerial: 1,
    serverAcceptedSampleCount: 1_600,
  })).action, 'demote-webtransport');

  assert.equal(observe(recovery, observation({
    capturedSamples: 96_000,
    serverAcceptedFrameSerial: 2,
    serverAcceptedSampleCount: 3_200,
    serverMediaPath: 'websocket',
    path: 'websocket',
  })).reason, 'server-websocket-rebaseline');

  const recovered = observe(recovery, observation({
    capturedSamples: 144_000,
    serverAcceptedFrameSerial: 3,
    serverAcceptedSampleCount: 51_200,
    serverMediaPath: 'websocket',
    path: 'websocket',
  }));
  assert.equal(recovered.action, 'recovered');
  assert.equal(recovered.reason, 'server-pcm-coverage-recovered-on-websocket');
});
