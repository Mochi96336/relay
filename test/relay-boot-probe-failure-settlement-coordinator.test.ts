import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRelayBootProbeFailureSettlementCoordinator,
} from '../src/relay-boot-probe-failure-settlement-coordinator.js';

test('terminal Boot Probe failure restores timing provenance before synchronous settlement', () => {
  const events: string[] = [];
  let provenanceRestored = false;

  const coordinator = createRelayBootProbeFailureSettlementCoordinator({
    restoreCandidateKindToAuthority: () => {
      events.push('restore-provenance');
      provenanceRestored = true;
    },
    failPreservingPrimed: (message) => {
      assert.equal(provenanceRestored, true, 'terminal settlement must follow provenance restore');
      assert.equal(message, 'probe exhausted');
      events.push('fail-settlement');
    },
    reportTimingStatus: () => events.push('report-timing'),
  });

  assert.equal(coordinator.settle({ message: 'probe exhausted' }), 'terminal');
  assert.deepEqual(events, ['restore-provenance', 'fail-settlement']);
});

test('retrying Boot Probe failure only republishes timing status', () => {
  const events: string[] = [];

  const coordinator = createRelayBootProbeFailureSettlementCoordinator({
    restoreCandidateKindToAuthority: () => events.push('restore-provenance'),
    failPreservingPrimed: (message) => events.push(`fail:${message}`),
    reportTimingStatus: () => events.push('report-timing'),
  });

  assert.equal(coordinator.settle(null), 'retrying');
  assert.deepEqual(events, ['report-timing']);
});
