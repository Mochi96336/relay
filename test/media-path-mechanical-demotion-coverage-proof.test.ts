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
    serverAcceptedFrameSerial: 100,
    senderSubmittedPackets: 100,
    senderFailedPackets: 0,
    serverReceivedPacketSerial: 100,
    serverMediaPath: 'webtransport',
    path: 'webtransport',
    socketEpoch: 1,
    eligible: true,
    ...overrides,
  };
}

test('independent WT mechanical demotion cannot spend the WS recovery budget with a mixed-path coverage window', () => {
  const recovery = new MicMediaPathRecovery();
  recovery.observe(observation());

  let decision = recovery.observe(observation({
    capturedSamples: 96_000,
    serverAcceptedFrameSerial: 101,
    senderSubmittedPackets: 200,
    serverReceivedPacketSerial: 110,
  }));
  assert.equal(decision.action, 'none');
  assert.equal(decision.staleObservations, 1);

  decision = recovery.observe(observation({
    capturedSamples: 144_000,
    serverAcceptedFrameSerial: 102,
    senderSubmittedPackets: 300,
    serverReceivedPacketSerial: 120,
  }));
  assert.equal(decision.action, 'none');
  assert.equal(decision.staleObservations, 2);

  // #287 can demote WebTransport mechanically between health observations.
  // The next health snapshot is labelled WebSocket, but its cumulative packet
  // delta can still contain failed WT submissions from before that demotion.
  // That mixed-path interval is not evidence against the new WebSocket path.
  decision = recovery.observe(observation({
    capturedSamples: 153_600,
    serverAcceptedFrameSerial: 103,
    senderSubmittedPackets: 410,
    serverReceivedPacketSerial: 130,
    serverMediaPath: 'websocket',
    path: 'websocket',
  }));

  assert.equal(decision.action, 'none',
    'the first observation after an independently-owned media-path change must rebaseline rather than close the replacement path');
  assert.equal(decision.staleObservations, 0,
    'WT under-delivery evidence must not cross the local WT→WS attribution boundary');
  assert.equal(decision.webSocketReplacementUsed, false);
  assert.equal(decision.webTransportDemotionUsed, false,
    '#287 owns this demotion; media recovery must not retroactively spend its semantic WT action');

  // After the new path owns a clean baseline, genuine sustained WS
  // under-delivery must still spend exactly the existing bounded replacement.
  for (let index = 1; index <= 3; index += 1) {
    decision = recovery.observe(observation({
      capturedSamples: 153_600 + 48_000 * index,
      serverAcceptedFrameSerial: 103 + index,
      senderSubmittedPackets: 410 + 100 * index,
      serverReceivedPacketSerial: 130 + 10 * index,
      serverMediaPath: 'websocket',
      path: 'websocket',
    }));
  }

  assert.equal(decision.action, 'replace-websocket');
  assert.equal(decision.reason, 'server-pcm-underdelivery');
  assert.equal(decision.webSocketReplacementUsed, true);
  assert.equal(decision.webTransportDemotionUsed, false);
});
