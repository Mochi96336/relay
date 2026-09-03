import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  parseTypeScriptSource,
  sourceCode,
  variableInitializerCode,
} from './support/source-contract.js';

const server = parseTypeScriptSource(
  new URL('../src/server.ts', import.meta.url),
  readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'),
);
const coordinator = parseTypeScriptSource(
  new URL('../src/relay-robot-content-transition-commit-coordinator.ts', import.meta.url),
  readFileSync(new URL('../src/relay-robot-content-transition-commit-coordinator.ts', import.meta.url), 'utf8'),
);
const serverCode = sourceCode(server);
const coordinatorCode = sourceCode(coordinator);

test('server composes Robot transition commit effects behind one ordering seam', () => {
  assert.ok(serverCode.includes(
    "import { createRelayRobotContentTransitionCommitCoordinator } from './relay-robot-content-transition-commit-coordinator.js';",
  ));

  const composition = variableInitializerCode(server, 'robotContentTransitionCommitCoordinator');
  assert.ok(composition.includes('robotContentTimeline.noteBackingBoundary(boundarySample, context, nowMs)'));
  assert.ok(composition.includes('calibration.restartWorkingEvidence(nowMs)'));
  assert.ok(composition.includes('contentCalibrationValidator.collecting'));
  assert.ok(composition.includes('contentCalibrationValidator.cancel(nowMs)'));
  assert.ok(composition.includes('feedContentBackingEvidence(samples, start, nowMs)'));
  assert.ok(composition.includes('robotContentTimeline.mapBackingStart(start, context, nowMs)'));
});

test('RobotContentTransitionRuntime host delegates commit instead of repeating cross-domain effects inline', () => {
  const runtime = variableInitializerCode(server, 'robotContentTransitionRuntime');
  assert.ok(runtime.includes(
    'commit: (plan, nowMs) => robotContentTransitionCommitCoordinator.commit(plan, nowMs)',
  ));
  assert.equal(runtime.includes('robotContentTimeline.noteBackingBoundary'), false);
  assert.equal(runtime.includes('calibration.restartWorkingEvidence'), false);
  assert.equal(runtime.includes('contentCalibrationValidator'), false);
  assert.equal(runtime.includes('feedContentBackingEvidence'), false);
  assert.equal(runtime.includes('robotContentTimeline.mapBackingStart'), false);
});

test('commit coordinator owns ordering but no Robot timeline, calibration, validation, or server authority', () => {
  for (const forbiddenImport of [
    "from './robot-content-timeline.js'",
    "from './calibration-session.js'",
    "from './content-calibration-validator.js'",
    "from './server.js'",
  ]) {
    assert.equal(coordinatorCode.includes(forbiddenImport), false);
  }
  for (const forbiddenRuntime of [
    'robotContentTimeline',
    'calibration.',
    'contentCalibrationValidator',
    'feedContentBackingEvidence',
  ]) {
    assert.equal(coordinatorCode.includes(forbiddenRuntime), false);
  }
});
