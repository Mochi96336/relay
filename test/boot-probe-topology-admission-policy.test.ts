import assert from 'node:assert/strict';
import test from 'node:test';

import { bootProbeTopologyReady } from '../src/boot-probe-topology-admission-policy.js';

test('explicit Robot topology admits only when both infrastructure legs exist', () => {
  assert.equal(bootProbeTopologyReady({ backingIsRobot: true, robotSourceConnected: true }), true);
  assert.equal(bootProbeTopologyReady({ backingIsRobot: false, robotSourceConnected: true }), false);
  assert.equal(bootProbeTopologyReady({ backingIsRobot: true, robotSourceConnected: false }), false);
  assert.equal(bootProbeTopologyReady({ backingIsRobot: false, robotSourceConnected: false }), false);
});

test('legacy omitted topology facts remain permissive while explicit false still fails closed', () => {
  assert.equal(bootProbeTopologyReady({}), true);
  assert.equal(bootProbeTopologyReady({ backingIsRobot: true }), true);
  assert.equal(bootProbeTopologyReady({ robotSourceConnected: true }), true);
  assert.equal(bootProbeTopologyReady({ backingIsRobot: false }), false);
  assert.equal(bootProbeTopologyReady({ robotSourceConnected: false }), false);
});
