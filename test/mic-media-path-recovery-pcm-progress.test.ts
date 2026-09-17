import assert from 'node:assert/strict';
import test from 'node:test';

import { MicMediaPathRecovery } from '../public/mic-media-path-recovery.js';

function observation(overrides: Record<string, unknown> = {}) {
  return {
    captureGeneration: 7,
    capturedSamples: 1_000,
    serverAcceptedFrameSerial: 10,
    serverMediaPath: 'webtransport' as 'webtransport' | 'websocket' | null,
    path: 'webtransport' as 'webtransport' | 'websocket',
    socketEpoch: 1,
    eligible: true,
    ...overrides,
  };
}

test('lingering WT path label cannot escalate while server accepted PCM keeps advancing', () => {
  const recovery = new MicMediaPathRecovery();

  assert.equal(recovery.observe(observation({ capturedSamples: 1_000 })).reason, 'baseline');
  assert.equal(recovery.observe(observation({ capturedSamples: 1_100 })).action, 'none');
  assert.equal(recovery.observe(observation({ capturedSamples: 1_200 })).action, 'none');

  const demoted = recovery.observe(observation({ capturedSamples: 1_300 }));
  assert.equal(demoted.action, 'demote-webtransport');
  assert.equal(demoted.webTransportQuarantined, true);
  assert.equal(demoted.webSocketReplacementUsed, false);

  // The browser has already fallen back to WS, but the server still reports
  // the old WT session while its teardown converges. Accepted PCM continuing to
  // advance proves the original failure class is gone, so this label lag must
  // not spend the physical WebSocket replacement budget.
  for (const [capturedSamples, serial] of [
    [1_400, 11],
    [1_500, 12],
    [1_600, 13],
    [1_700, 14],
  ] as const) {
    const decision = recovery.observe(observation({
      capturedSamples,
      serverAcceptedFrameSerial: serial,
      serverMediaPath: 'webtransport',
      path: 'websocket',
    }));
    assert.equal(decision.action, 'none');
    assert.equal(decision.reason, 'waiting-server-websocket');
    assert.equal(decision.staleObservations, 0);
    assert.equal(decision.webSocketReplacementUsed, false);
    assert.equal(decision.degraded, false);
  }

  // The first server-side WS observation establishes a proof baseline only.
  const wsBaseline = recovery.observe(observation({
    capturedSamples: 1_800,
    serverAcceptedFrameSerial: 14,
    serverMediaPath: 'websocket',
    path: 'websocket',
  }));
  assert.equal(wsBaseline.action, 'none');
  assert.equal(wsBaseline.reason, 'server-websocket-rebaseline');
  assert.equal(wsBaseline.proofBaselineSerial, 14);

  // A later accepted frame while the server agrees WS is live proves recovery.
  const recovered = recovery.observe(observation({
    capturedSamples: 1_900,
    serverAcceptedFrameSerial: 15,
    serverMediaPath: 'websocket',
    path: 'websocket',
  }));
  assert.equal(recovered.action, 'recovered');
  assert.equal(recovered.reason, 'server-pcm-advanced-on-websocket');
  assert.equal(recovered.webSocketReplacementUsed, false);
  assert.equal(recovered.webTransportQuarantined, true);
});
