import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRelayBootProbeCalibrationPromotionCoordinator,
} from '../src/relay-boot-probe-calibration-promotion-coordinator.js';

test('Boot Probe promotion mutates probe state before timing authority and lazy result settlement', () => {
  const events: string[] = [];
  let probeMutated = false;
  let timingMarked = false;

  const coordinator = createRelayBootProbeCalibrationPromotionCoordinator({
    markBootProbeAuthority: () => {
      assert.equal(probeMutated, true, 'timing authority must follow the probe mutation');
      events.push('timing-authority');
      timingMarked = true;
    },
    applyExternalResult: (result) => {
      assert.equal(timingMarked, true, 'calibration settlement must follow timing authority');
      assert.deepEqual(result, { micLagMs: 137, confidence: 0.82 });
      events.push('apply-result');
    },
  });

  coordinator.promote(
    () => {
      events.push('probe-mutation');
      probeMutated = true;
    },
    () => {
      assert.equal(probeMutated, true, 'lazy result must observe the promoted probe state');
      assert.equal(timingMarked, true, 'lazy result must be read after timing authority is coherent');
      events.push('read-result');
      return { micLagMs: 137, confidence: 0.82 };
    },
  );

  assert.deepEqual(events, [
    'probe-mutation',
    'timing-authority',
    'read-result',
    'apply-result',
  ]);
});
