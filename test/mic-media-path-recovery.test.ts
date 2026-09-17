import assert from 'node:assert/strict';
import test from 'node:test';

import { MicMediaPathRecovery } from '../public/mic-media-path-recovery.js';

type Path = 'webtransport' | 'websocket';

type Observation = {
  captureGeneration: number;
  capturedSamples: number;
  serverAcceptedFrameSerial: number;
  serverMediaPath: Path | null;
  path: Path;
  socketEpoch: number;
  eligible: boolean;
};

function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    captureGeneration: 7,
    capturedSamples: 1_000,
    serverAcceptedFrameSerial: 10,
    serverMediaPath: 'webtransport',
    path: 'webtransport',
    socketEpoch: 1,
    eligible: true,
    ...overrides,
  };
}

function advanceStale(
  recovery: MicMediaPathRecovery,
  {
    fromCaptured,
    count,
    path = 'webtransport' as Path,
    socketEpoch = 1,
    serial = 10,
    serverMediaPath = path,
  }: {
    fromCaptured: number;
    count: number;
    path?: Path;
    socketEpoch?: number;
    serial?: number;
    serverMediaPath?: Path | null;
  },
) {
  let decision = recovery.observe(observation({
    capturedSamples: fromCaptured,
    path,
    socketEpoch,
    serverAcceptedFrameSerial: serial,
    serverMediaPath,
  }));
  for (let i = 1; i <= count; i += 1) {
    decision = recovery.observe(observation({
      capturedSamples: fromCaptured + i * 100,
      path,
      socketEpoch,
      serverAcceptedFrameSerial: serial,
      serverMediaPath,
    }));
  }
  return decision;
}

test('three accepted-PCM-stale observations demote WebTransport exactly once', () => {
  const recovery = new MicMediaPathRecovery();
  const decision = advanceStale(recovery, { fromCaptured: 1_000, count: 3 });

  assert.equal(decision.action, 'demote-webtransport');
  assert.equal(decision.reason, 'server-pcm-stale');
  assert.equal(decision.captureGeneration, 7);
  assert.equal(decision.webTransportDemotionUsed, true);
  assert.equal(decision.webTransportQuarantined, true);
  assert.equal(decision.webSocketReplacementUsed, false);
  assert.equal(decision.proofBaselineSerial, null);
});

test('one or two stale observations cannot trigger semantic recovery', () => {
  const recovery = new MicMediaPathRecovery();
  assert.equal(recovery.observe(observation({ capturedSamples: 1_000 })).action, 'none');
  assert.equal(recovery.observe(observation({ capturedSamples: 1_100 })).action, 'none');
  assert.equal(recovery.observe(observation({ capturedSamples: 1_200 })).action, 'none');
  assert.equal(recovery.status().webTransportDemotionUsed, false);
});

test('accepted server PCM progress clears stale evidence before the threshold', () => {
  const recovery = new MicMediaPathRecovery();
  recovery.observe(observation({ capturedSamples: 1_000, serverAcceptedFrameSerial: 10 }));
  recovery.observe(observation({ capturedSamples: 1_100, serverAcceptedFrameSerial: 10 }));
  recovery.observe(observation({ capturedSamples: 1_200, serverAcceptedFrameSerial: 10 }));

  const progress = recovery.observe(observation({
    capturedSamples: 1_300,
    serverAcceptedFrameSerial: 11,
  }));
  assert.equal(progress.action, 'none');
  assert.equal(progress.reason, 'server-pcm-advancing');
  assert.equal(progress.staleObservations, 0);

  const after = recovery.observe(observation({
    capturedSamples: 1_400,
    serverAcceptedFrameSerial: 11,
  }));
  assert.equal(after.action, 'none');
  assert.equal(after.staleObservations, 1);
});

test('local capture stall never spends media recovery budget', () => {
  const recovery = new MicMediaPathRecovery();
  recovery.observe(observation({ capturedSamples: 1_000 }));
  for (let i = 0; i < 10; i += 1) {
    const decision = recovery.observe(observation({ capturedSamples: 1_000 }));
    assert.equal(decision.action, 'none');
    assert.equal(decision.reason, 'local-capture-not-advancing');
  }
  assert.equal(recovery.status().webTransportDemotionUsed, false);
  assert.equal(recovery.status().webSocketReplacementUsed, false);
});

test('ineligible observations rebaseline instead of diagnosing background suspension', () => {
  const recovery = new MicMediaPathRecovery();
  recovery.observe(observation({ capturedSamples: 1_000 }));
  for (let i = 1; i <= 5; i += 1) {
    const decision = recovery.observe(observation({
      capturedSamples: 1_000 + i * 100,
      eligible: false,
    }));
    assert.equal(decision.action, 'none');
    assert.equal(decision.reason, 'ineligible');
  }
  assert.equal(recovery.status().staleObservations, 0);
  assert.equal(recovery.status().webTransportDemotionUsed, false);

  const foreground = recovery.observe(observation({
    capturedSamples: 1_700,
    eligible: true,
  }));
  assert.equal(foreground.action, 'none');
  assert.equal(foreground.staleObservations, 1);
});

test('late WT acceptance cannot prove fallback until server has switched to WebSocket and PCM advances after that baseline', () => {
  const recovery = new MicMediaPathRecovery();
  assert.equal(
    advanceStale(recovery, { fromCaptured: 1_000, count: 3 }).action,
    'demote-webtransport',
  );

  // A frame that was already in the direct-media path lands after local
  // demotion. The serial moved, but server still reports WT, so this cannot
  // count as fallback recovery.
  const lateWt = recovery.observe(observation({
    capturedSamples: 1_400,
    serverAcceptedFrameSerial: 11,
    serverMediaPath: 'webtransport',
    path: 'websocket',
  }));
  assert.equal(lateWt.action, 'none');
  assert.equal(lateWt.reason, 'waiting-server-websocket');

  // First ACK after the server agrees WT is gone establishes a fresh proof
  // baseline. Even though the serial is already 11, it still is not success.
  const wsBaseline = recovery.observe(observation({
    capturedSamples: 1_500,
    serverAcceptedFrameSerial: 11,
    serverMediaPath: 'websocket',
    path: 'websocket',
  }));
  assert.equal(wsBaseline.action, 'none');
  assert.equal(wsBaseline.reason, 'server-websocket-rebaseline');
  assert.equal(wsBaseline.proofBaselineSerial, 11);

  const recovered = recovery.observe(observation({
    capturedSamples: 1_600,
    serverAcceptedFrameSerial: 12,
    serverMediaPath: 'websocket',
    path: 'websocket',
  }));
  assert.equal(recovered.action, 'recovered');
  assert.equal(recovered.reason, 'server-pcm-advanced-on-websocket');
  assert.equal(recovered.webTransportQuarantined, true);
});

test('failed fallback permits one same-generation WebSocket replacement then latches degraded', () => {
  const recovery = new MicMediaPathRecovery();
  assert.equal(
    advanceStale(recovery, { fromCaptured: 1_000, count: 3 }).action,
    'demote-webtransport',
  );

  let decision = recovery.observe(observation({
    capturedSamples: 1_400,
    serverAcceptedFrameSerial: 10,
    serverMediaPath: 'websocket',
    path: 'websocket',
  }));
  assert.equal(decision.reason, 'server-websocket-rebaseline');

  for (const capturedSamples of [1_500, 1_600]) {
    decision = recovery.observe(observation({
      capturedSamples,
      serverAcceptedFrameSerial: 10,
      serverMediaPath: 'websocket',
      path: 'websocket',
    }));
    assert.equal(decision.action, 'none');
  }
  decision = recovery.observe(observation({
    capturedSamples: 1_700,
    serverAcceptedFrameSerial: 10,
    serverMediaPath: 'websocket',
    path: 'websocket',
  }));
  assert.equal(decision.action, 'replace-websocket');
  assert.equal(decision.webSocketReplacementUsed, true);

  // The replacement physical socket creates a new ACK epoch and therefore a
  // fresh accepted-frame baseline.
  decision = recovery.observe(observation({
    capturedSamples: 1_800,
    serverAcceptedFrameSerial: 10,
    serverMediaPath: 'websocket',
    path: 'websocket',
    socketEpoch: 2,
  }));
  assert.equal(decision.action, 'none');
  assert.equal(decision.reason, 'socket-rebaseline');
  assert.equal(decision.proofBaselineSerial, 10);

  for (const capturedSamples of [1_900, 2_000]) {
    decision = recovery.observe(observation({
      capturedSamples,
      serverAcceptedFrameSerial: 10,
      serverMediaPath: 'websocket',
      path: 'websocket',
      socketEpoch: 2,
    }));
    assert.equal(decision.action, 'none');
  }
  decision = recovery.observe(observation({
    capturedSamples: 2_100,
    serverAcceptedFrameSerial: 10,
    serverMediaPath: 'websocket',
    path: 'websocket',
    socketEpoch: 2,
  }));
  assert.equal(decision.action, 'degraded-latched');
  assert.equal(decision.degraded, true);

  for (let i = 1; i <= 5; i += 1) {
    decision = recovery.observe(observation({
      capturedSamples: 2_100 + i * 100,
      serverAcceptedFrameSerial: 10,
      serverMediaPath: 'websocket',
      path: 'websocket',
      socketEpoch: 2,
    }));
    assert.equal(decision.action, 'none');
    assert.equal(decision.reason, 'degraded-latched');
  }
});

test('WebSocket-only capture skips WT action and still has a bounded reconnect budget', () => {
  const recovery = new MicMediaPathRecovery();
  const decision = advanceStale(recovery, {
    fromCaptured: 1_000,
    count: 3,
    path: 'websocket',
    serverMediaPath: 'websocket',
  });
  assert.equal(decision.action, 'replace-websocket');
  assert.equal(decision.webTransportDemotionUsed, false);
  assert.equal(decision.webSocketReplacementUsed, true);
});

test('socket epoch change fences old ACK cadence without clearing same-generation WT quarantine', () => {
  const recovery = new MicMediaPathRecovery();
  assert.equal(
    advanceStale(recovery, { fromCaptured: 1_000, count: 3 }).action,
    'demote-webtransport',
  );

  const changed = recovery.observe(observation({
    capturedSamples: 1_400,
    serverAcceptedFrameSerial: 10,
    serverMediaPath: 'websocket',
    path: 'websocket',
    socketEpoch: 9,
  }));
  assert.equal(changed.action, 'none');
  assert.equal(changed.reason, 'socket-rebaseline');
  assert.equal(changed.staleObservations, 0);
  assert.equal(changed.proofBaselineSerial, 10);
  assert.equal(changed.webTransportQuarantined, true);
});

test('new capture reset clears WT quarantine and bounded action budget', () => {
  const recovery = new MicMediaPathRecovery();
  assert.equal(
    advanceStale(recovery, { fromCaptured: 1_000, count: 3 }).action,
    'demote-webtransport',
  );
  assert.equal(recovery.quarantineWebTransport(), true);

  recovery.reset();
  const next = recovery.observe(observation({
    captureGeneration: 8,
    capturedSamples: 100,
    serverAcceptedFrameSerial: 0,
    serverMediaPath: null,
  }));
  assert.equal(next.action, 'none');
  assert.equal(next.captureGeneration, 8);
  assert.equal(next.webTransportQuarantined, false);
  assert.equal(next.webTransportDemotionUsed, false);
  assert.equal(next.webSocketReplacementUsed, false);
});

test('degraded latch may clear on spontaneous accepted PCM without restoring WT or action budget', () => {
  const recovery = new MicMediaPathRecovery({ staleObservations: 1 });
  recovery.observe(observation({ capturedSamples: 1_000 }));
  assert.equal(
    recovery.observe(observation({ capturedSamples: 1_100 })).action,
    'demote-webtransport',
  );
  assert.equal(
    recovery.observe(observation({
      capturedSamples: 1_200,
      serverAcceptedFrameSerial: 10,
      serverMediaPath: 'websocket',
      path: 'websocket',
    })).reason,
    'server-websocket-rebaseline',
  );
  assert.equal(
    recovery.observe(observation({
      capturedSamples: 1_300,
      serverAcceptedFrameSerial: 10,
      serverMediaPath: 'websocket',
      path: 'websocket',
    })).action,
    'replace-websocket',
  );
  assert.equal(
    recovery.observe(observation({
      capturedSamples: 1_400,
      serverAcceptedFrameSerial: 10,
      serverMediaPath: 'websocket',
      path: 'websocket',
      socketEpoch: 2,
    })).reason,
    'socket-rebaseline',
  );
  assert.equal(
    recovery.observe(observation({
      capturedSamples: 1_500,
      serverAcceptedFrameSerial: 10,
      serverMediaPath: 'websocket',
      path: 'websocket',
      socketEpoch: 2,
    })).action,
    'degraded-latched',
  );

  const recovered = recovery.observe(observation({
    capturedSamples: 1_600,
    serverAcceptedFrameSerial: 11,
    serverMediaPath: 'websocket',
    path: 'websocket',
    socketEpoch: 2,
  }));
  assert.equal(recovered.action, 'recovered');
  assert.equal(recovered.webTransportQuarantined, true);
  assert.equal(recovered.webTransportDemotionUsed, true);
  assert.equal(recovered.webSocketReplacementUsed, true);
});
