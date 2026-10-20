import assert from 'node:assert/strict';
import test from 'node:test';

import { readSourceContract, variableInitializerCode } from './support/source-contract.js';

const server = readSourceContract('src/server.ts');

test('RobotContentTransitionRuntime host delegates commit instead of repeating cross-domain effects inline', () => {
  const runtime = variableInitializerCode(server, 'robotContentTransitionRuntime');
  assert.ok(runtime.includes(
    'commit: (plan, nowMs) => commitRobotContentTransition(plan, nowMs)',
  ));
  assert.equal(runtime.includes('robotContentTimeline.noteBackingBoundary'), false);
  assert.equal(runtime.includes('calibration.restartWorkingEvidence'), false);
  assert.equal(runtime.includes('contentCalibrationValidator'), false);
  assert.equal(runtime.includes('feedContentBackingEvidence'), false);
  assert.equal(runtime.includes('robotContentTimeline.mapBackingStart'), false);
});
