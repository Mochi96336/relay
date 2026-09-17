import assert from 'node:assert/strict';
import test from 'node:test';

import { MicMediaPathRecovery } from '../public/mic-media-path-recovery.js';

type Path = 'webtransport' | 'websocket';

type Observation = {
  captureGeneration: number;
  capturedSamples: number;
  serverAcceptedFrameSerial: number;
  senderSubmittedPackets: number;
  senderFailedPackets: number;
  serverReceivedPacketSerial: number;
  serverMediaPath: Path | null;
  path: Path;
  socketEpoch: number;
  eligible: boolean;
};

function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    captureGeneration: 7,
    capturedSamples: 48_000,
    serverAcceptedFrameSerial: 10,
    senderSubmittedPackets: 100,
    senderFailedPackets: 0,
    serverReceivedPacketSerial: 100,
    serverMediaPath: 'websocket',
    path: 'websocket',
    socketEpoch: 1,
    eligible: true,
    ...overrides,
  };
}

test('healthy receiver packet coverage cannot mask a stalled AudioSession acceptance frontier', () => {
  const recovery = new MicMediaPathRecovery();
  recovery.observe(observation());

  let decision;
  for (let index = 1; index <= 3; index += 1) {
    decision = recovery.observe(observation({
      capturedSamples: 48_000 * (index + 1),
      // Receiver delivery stays perfect, but AudioSession accepts no novel PCM.
      serverAcceptedFrameSerial: 10,
      senderSubmittedPackets: 100 * (index + 1),
      serverReceivedPacketSerial: 100 * (index + 1),
    }));
  }

  assert.equal(decision?.action, 'replace-websocket');
  assert.equal(decision?.reason, 'server-pcm-stale');
  assert.equal(decision?.packetCoverage, 1);
  assert.equal(decision?.webSocketReplacementUsed, true);
});

test('an incomplete packet window cannot postpone an established semantic PCM stall', () => {
  const recovery = new MicMediaPathRecovery({ staleObservations: 2, minPacketWindow: 8 });
  recovery.observe(observation());

  let decision;
  for (let index = 1; index <= 2; index += 1) {
    decision = recovery.observe(observation({
      capturedSamples: 48_000 * (index + 1),
      serverAcceptedFrameSerial: 10,
      // Quantitative evidence exists but remains below its minimum window.
      // That uncertainty may defer an under-delivery verdict, but it cannot
      // erase the independent accepted-PCM stall authority.
      senderSubmittedPackets: 100 + index,
      serverReceivedPacketSerial: 100 + index,
    }));
  }

  assert.equal(decision?.action, 'replace-websocket');
  assert.equal(decision?.reason, 'server-pcm-stale');
  assert.equal(decision?.webSocketReplacementUsed, true);
});

test('healthy fallback packet coverage cannot prove recovery without novel accepted PCM', () => {
  const recovery = new MicMediaPathRecovery({ staleObservations: 1 });
  recovery.observe(observation({
    path: 'webtransport',
    serverMediaPath: 'webtransport',
  }));

  const demoted = recovery.observe(observation({
    capturedSamples: 96_000,
    serverAcceptedFrameSerial: 11,
    senderSubmittedPackets: 200,
    serverReceivedPacketSerial: 110,
    path: 'webtransport',
    serverMediaPath: 'webtransport',
  }));
  assert.equal(demoted.action, 'demote-webtransport');

  const baseline = recovery.observe(observation({
    capturedSamples: 144_000,
    serverAcceptedFrameSerial: 12,
    senderSubmittedPackets: 300,
    serverReceivedPacketSerial: 120,
    path: 'websocket',
    serverMediaPath: 'websocket',
  }));
  assert.equal(baseline.reason, 'server-websocket-rebaseline');

  const stalled = recovery.observe(observation({
    capturedSamples: 192_000,
    serverAcceptedFrameSerial: 12,
    senderSubmittedPackets: 400,
    serverReceivedPacketSerial: 220,
    path: 'websocket',
    serverMediaPath: 'websocket',
  }));
  assert.equal(stalled.action, 'replace-websocket');
  assert.equal(stalled.reason, 'server-pcm-stale-after-fallback');
  assert.equal(stalled.packetCoverage, 1);
});

test('an incomplete fallback packet window cannot postpone a semantic PCM stall', () => {
  const recovery = new MicMediaPathRecovery({ staleObservations: 1, minPacketWindow: 8 });
  recovery.observe(observation({
    path: 'webtransport',
    serverMediaPath: 'webtransport',
  }));

  const demoted = recovery.observe(observation({
    capturedSamples: 96_000,
    serverAcceptedFrameSerial: 11,
    senderSubmittedPackets: 200,
    serverReceivedPacketSerial: 110,
    path: 'webtransport',
    serverMediaPath: 'webtransport',
  }));
  assert.equal(demoted.action, 'demote-webtransport');

  const baseline = recovery.observe(observation({
    capturedSamples: 144_000,
    serverAcceptedFrameSerial: 12,
    senderSubmittedPackets: 300,
    serverReceivedPacketSerial: 120,
    path: 'websocket',
    serverMediaPath: 'websocket',
  }));
  assert.equal(baseline.reason, 'server-websocket-rebaseline');

  const stalled = recovery.observe(observation({
    capturedSamples: 192_000,
    serverAcceptedFrameSerial: 12,
    senderSubmittedPackets: 301,
    serverReceivedPacketSerial: 121,
    path: 'websocket',
    serverMediaPath: 'websocket',
  }));
  assert.equal(stalled.action, 'replace-websocket');
  assert.equal(stalled.reason, 'server-pcm-stale-after-fallback');
});

test('degraded latch cannot clear from packet delivery alone while accepted PCM remains stalled', () => {
  const recovery = new MicMediaPathRecovery({ staleObservations: 1 });
  recovery.observe(observation());

  const replaced = recovery.observe(observation({
    capturedSamples: 96_000,
    serverAcceptedFrameSerial: 11,
    senderSubmittedPackets: 200,
    serverReceivedPacketSerial: 110,
  }));
  assert.equal(replaced.action, 'replace-websocket');

  const rebound = recovery.observe(observation({
    capturedSamples: 144_000,
    serverAcceptedFrameSerial: 11,
    senderSubmittedPackets: 300,
    serverReceivedPacketSerial: 120,
    socketEpoch: 2,
  }));
  assert.equal(rebound.reason, 'socket-rebaseline');

  const degraded = recovery.observe(observation({
    capturedSamples: 192_000,
    serverAcceptedFrameSerial: 11,
    senderSubmittedPackets: 400,
    serverReceivedPacketSerial: 130,
    socketEpoch: 2,
  }));
  assert.equal(degraded.action, 'degraded-latched');

  const packetOnlyRecovery = recovery.observe(observation({
    capturedSamples: 240_000,
    serverAcceptedFrameSerial: 11,
    senderSubmittedPackets: 500,
    serverReceivedPacketSerial: 230,
    socketEpoch: 2,
  }));
  assert.equal(packetOnlyRecovery.action, 'none');
  assert.equal(packetOnlyRecovery.reason, 'degraded-latched');
  assert.equal(packetOnlyRecovery.degraded, true);
  assert.equal(packetOnlyRecovery.packetCoverage, 1);
});
