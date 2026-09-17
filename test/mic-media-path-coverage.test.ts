import assert from 'node:assert/strict';
import test from 'node:test';

import { MicMediaPathRecovery } from '../public/mic-media-path-recovery.js';

type Path = 'webtransport' | 'websocket';

type CoverageObservation = {
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

function observation(overrides: Partial<CoverageObservation> = {}): CoverageObservation {
  return {
    captureGeneration: 7,
    capturedSamples: 48_000,
    serverAcceptedFrameSerial: 100,
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

test('healthy packet coverage clears stale evidence', () => {
  const recovery = new MicMediaPathRecovery();
  recovery.observe(observation());

  const decision = recovery.observe(observation({
    capturedSamples: 96_000,
    serverAcceptedFrameSerial: 101,
    senderSubmittedPackets: 200,
    serverReceivedPacketSerial: 180,
  }));

  assert.equal(decision.action, 'none');
  assert.equal(decision.reason, 'server-pcm-coverage-healthy');
  assert.equal(decision.packetCoverage, 0.8);
  assert.equal(decision.staleObservations, 0);
});

test('accepted-frame progress cannot mask three severe packet under-delivery windows', () => {
  const recovery = new MicMediaPathRecovery();
  recovery.observe(observation());

  let decision = recovery.observe(observation({
    capturedSamples: 96_000,
    serverAcceptedFrameSerial: 101,
    senderSubmittedPackets: 200,
    serverReceivedPacketSerial: 110,
  }));
  assert.equal(decision.action, 'none');
  assert.equal(decision.reason, 'server-pcm-underdelivery-observation');
  assert.equal(decision.staleObservations, 1);
  assert.equal(decision.packetCoverage, 0.1);

  decision = recovery.observe(observation({
    capturedSamples: 144_000,
    serverAcceptedFrameSerial: 102,
    senderSubmittedPackets: 300,
    serverReceivedPacketSerial: 120,
  }));
  assert.equal(decision.action, 'none');
  assert.equal(decision.staleObservations, 2);

  decision = recovery.observe(observation({
    capturedSamples: 192_000,
    serverAcceptedFrameSerial: 103,
    senderSubmittedPackets: 400,
    serverReceivedPacketSerial: 130,
  }));
  assert.equal(decision.action, 'replace-websocket');
  assert.equal(decision.reason, 'server-pcm-underdelivery');
  assert.equal(decision.webSocketReplacementUsed, true);
});

test('severe WebTransport packet under-delivery spends demotion before socket replacement', () => {
  const recovery = new MicMediaPathRecovery();
  recovery.observe(observation({
    path: 'webtransport',
    serverMediaPath: 'webtransport',
  }));

  let decision;
  for (let index = 1; index <= 3; index += 1) {
    decision = recovery.observe(observation({
      capturedSamples: 48_000 * (index + 1),
      serverAcceptedFrameSerial: 100 + index,
      senderSubmittedPackets: 100 * (index + 1),
      serverReceivedPacketSerial: 100 + index * 10,
      path: 'webtransport',
      serverMediaPath: 'webtransport',
    }));
  }

  assert.equal(decision!.action, 'demote-webtransport');
  assert.equal(decision!.reason, 'server-pcm-underdelivery');
  assert.equal(decision!.webTransportDemotionUsed, true);
  assert.equal(decision!.webTransportQuarantined, true);
  assert.equal(decision!.webSocketReplacementUsed, false);
});

test('known sender-side asynchronous failures are excluded from deliverable coverage', () => {
  const recovery = new MicMediaPathRecovery();
  recovery.observe(observation());

  const decision = recovery.observe(observation({
    capturedSamples: 96_000,
    serverAcceptedFrameSerial: 101,
    senderSubmittedPackets: 200,
    senderFailedPackets: 60,
    serverReceivedPacketSerial: 140,
  }));

  assert.equal(decision.action, 'none');
  assert.equal(decision.reason, 'server-pcm-coverage-healthy');
  assert.equal(decision.packetCoverage, 1,
    '40 server packets cover all 40 submissions still deliverable after 60 known WT failures');
  assert.equal(decision.staleObservations, 0);
});

test('small packet windows accumulate before quantitative coverage is trusted', () => {
  const recovery = new MicMediaPathRecovery({ minPacketWindow: 8 });
  recovery.observe(observation());

  let decision = recovery.observe(observation({
    capturedSamples: 52_000,
    serverAcceptedFrameSerial: 100,
    senderSubmittedPackets: 104,
    serverReceivedPacketSerial: 100,
  }));
  assert.equal(decision.action, 'none');
  assert.equal(decision.reason, 'packet-window-accumulating');
  assert.equal(decision.staleObservations, 0);

  decision = recovery.observe(observation({
    capturedSamples: 56_000,
    serverAcceptedFrameSerial: 100,
    senderSubmittedPackets: 108,
    serverReceivedPacketSerial: 100,
  }));
  assert.equal(decision.action, 'none');
  assert.equal(decision.reason, 'server-pcm-underdelivery-observation');
  assert.equal(decision.packetCoverage, 0);
  assert.equal(decision.staleObservations, 1);
});

test('counter regression rebaselines instead of manufacturing packet loss', () => {
  const recovery = new MicMediaPathRecovery();
  recovery.observe(observation());
  recovery.observe(observation({
    capturedSamples: 96_000,
    serverAcceptedFrameSerial: 101,
    senderSubmittedPackets: 200,
    serverReceivedPacketSerial: 190,
  }));

  const decision = recovery.observe(observation({
    capturedSamples: 144_000,
    serverAcceptedFrameSerial: 102,
    senderSubmittedPackets: 10,
    senderFailedPackets: 0,
    serverReceivedPacketSerial: 9,
  }));

  assert.equal(decision.action, 'none');
  assert.equal(decision.reason, 'packet-window-accumulating');
  assert.equal(decision.staleObservations, 0);
});
