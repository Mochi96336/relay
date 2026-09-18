import assert from 'node:assert/strict';
import test from 'node:test';

import { MicMediaPathRecovery } from '../public/mic-media-path-recovery.js';

function observe(
  recovery: MicMediaPathRecovery,
  capturedSamples: number,
  {
    path = 'webtransport' as 'webtransport' | 'websocket',
    serverMediaPath = path as 'webtransport' | 'websocket' | null,
    serial = 10,
    socketEpoch = 1,
  } = {},
) {
  return recovery.observe({
    captureGeneration: 7,
    capturedSamples,
    serverAcceptedFrameSerial: serial,
    serverMediaPath,
    path,
    socketEpoch,
    eligible: true,
  });
}

function demoteWt(recovery: MicMediaPathRecovery) {
  observe(recovery, 1_000);
  observe(recovery, 1_100);
  observe(recovery, 1_200);
  const decision = observe(recovery, 1_300);
  assert.equal(decision.action, 'demote-webtransport');
}

test('server that never retires WT is bounded by the same recovery ladder', () => {
  const recovery = new MicMediaPathRecovery();
  demoteWt(recovery);

  for (const capturedSamples of [1_400, 1_500]) {
    const decision = observe(recovery, capturedSamples, {
      path: 'websocket',
      serverMediaPath: 'webtransport',
    });
    assert.equal(decision.action, 'none');
    assert.equal(decision.reason, 'waiting-server-websocket');
  }
  const replace = observe(recovery, 1_600, {
    path: 'websocket',
    serverMediaPath: 'webtransport',
  });
  assert.equal(replace.action, 'replace-websocket');
  assert.equal(replace.webSocketReplacementUsed, true);

  // New physical socket, same capture generation. Its first current-socket ACK
  // cannot inherit the old socket's stale count.
  const rebound = observe(recovery, 1_700, {
    path: 'websocket',
    serverMediaPath: 'webtransport',
    socketEpoch: 2,
  });
  assert.equal(rebound.action, 'none');
  assert.equal(rebound.reason, 'socket-rebaseline');

  for (const capturedSamples of [1_800, 1_900]) {
    const decision = observe(recovery, capturedSamples, {
      path: 'websocket',
      serverMediaPath: 'webtransport',
      socketEpoch: 2,
    });
    assert.equal(decision.action, 'none');
  }
  const latched = observe(recovery, 2_000, {
    path: 'websocket',
    serverMediaPath: 'webtransport',
    socketEpoch: 2,
  });
  assert.equal(latched.action, 'degraded-latched');
  assert.equal(latched.degraded, true);
});

test('WebSocket-origin recovery quarantines WT before same-generation socket replacement', () => {
  const recovery = new MicMediaPathRecovery();

  observe(recovery, 1_000, { path: 'websocket', serverMediaPath: 'websocket' });
  observe(recovery, 1_100, { path: 'websocket', serverMediaPath: 'websocket' });
  observe(recovery, 1_200, { path: 'websocket', serverMediaPath: 'websocket' });
  const replace = observe(recovery, 1_300, {
    path: 'websocket',
    serverMediaPath: 'websocket',
  });

  assert.equal(replace.action, 'replace-websocket');
  assert.equal(replace.webTransportQuarantined, true);
  assert.equal(recovery.quarantineWebTransport(), true);
});
