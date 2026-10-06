import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  functionCode,
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
const mapping = parseTypeScriptSource(
  new URL('../src/relay-robot-mapping-orchestration.ts', import.meta.url),
  readFileSync(new URL('../src/relay-robot-mapping-orchestration.ts', import.meta.url), 'utf8'),
);

test('server composes Robot transition commit effects behind one ordering seam', () => {
  assert.ok(sourceCode(mapping).includes(
    "import { createRelayRobotContentTransitionCommitCoordinator } from './relay-robot-content-transition-commit-coordinator.js';",
  ));

  const composition = functionCode(mapping, 'createRelayRobotMappingCommit');
  assert.ok(composition.includes('dependencies.timeline.noteBackingBoundary(boundarySample, context, nowMs)'));
  assert.ok(composition.includes('dependencies.calibration.restartWorkingEvidence(nowMs)'));
  assert.ok(composition.includes('dependencies.validator.collecting'));
  assert.ok(composition.includes('dependencies.validator.cancel(nowMs)'));
  assert.ok(composition.includes('dependencies.effects.feedBackingEvidence(samples, start, nowMs)'));
  assert.ok(composition.includes('dependencies.timeline.mapBackingStart(start, context, nowMs)'));
  const root = variableInitializerCode(server, 'relayRobotMapping');
  assert.ok(root.includes('timeline: robotContentTimeline'));
  assert.ok(root.includes('calibration,'));
  assert.ok(root.includes('validator: contentCalibrationValidator'));
  assert.ok(root.includes('feedBackingEvidence: feedContentBackingEvidence'));
  assert.equal(serverCode.includes('robotContentTransitionCommitCoordinator'), false);
});

test('RobotContentTransitionRuntime host delegates commit instead of repeating cross-domain effects inline', () => {
  const runtime = variableInitializerCode(server, 'robotContentTransitionRuntime');
  assert.ok(runtime.includes(
    'commit: (plan, nowMs) => relayRobotMapping.commit(plan, nowMs)',
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
