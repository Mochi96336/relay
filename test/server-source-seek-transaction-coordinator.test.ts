import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  importSources,
  functionCode,
  objectArrowCallbackCode,
  parseTypeScriptSource,
  sourceCode,
  variableInitializerCode,
} from './support/source-contract.js';

const server = parseTypeScriptSource(
  new URL('../src/server.ts', import.meta.url),
  readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'),
);
const coordinator = parseTypeScriptSource(
  new URL('../src/relay-source-seek-transaction-coordinator.ts', import.meta.url),
  readFileSync(new URL('../src/relay-source-seek-transaction-coordinator.ts', import.meta.url), 'utf8'),
);
const mapping = parseTypeScriptSource(new URL('../src/relay-robot-mapping-orchestration.ts', import.meta.url),
  readFileSync(new URL('../src/relay-robot-mapping-orchestration.ts', import.meta.url), 'utf8'));

test('server retains Source seek authority and mapping classification before delegation', () => {
  assert.ok(importSources(mapping).includes('./relay-source-seek-transaction-coordinator.js'));
  const block = objectArrowCallbackCode(server, 'infrastructureEventProtocol', 'sourceSeeked');
  assert.match(block, /infrastructureCapability\.authorized\(socket\)/);
  assert.match(block, /sourceRuntime\.canReportSeek\(socket\)/);
  assert.match(block, /robotContentTransitionRuntime\.clearPendingBoundary\(\)/);
  assert.match(block, /payload\.reason === 'follower-correction'/);
  assert.match(block, /calibrationContext\(\)/);
  assert.match(block, /robotContentTimeline\.currentDeltaMs/);
  assert.match(block, /robotContentTimeline\.referenceDeltaMs/);
  assert.match(block, /robotContentTimeline\.noteFollowerCorrection\(/);
  assert.match(block, /relayRobotMapping\.handleSourceSeek\(\{/);

  assert.doesNotMatch(block, /robotPlayerOffset\.reset\(\)/);
  assert.doesNotMatch(block, /clearRobotContentTransition\(\)/);
  assert.doesNotMatch(block, /sourceRuntime\.invalidateMapping\(\)/);
  assert.doesNotMatch(block, /clearContentValidationBaseline\(\)/);
  assert.doesNotMatch(block, /calibration\.discardPrimedContent\(\)/);
  assert.doesNotMatch(block, /robotContentTimeline\.reset\(\)/);
  assert.doesNotMatch(block, /calibration\.fail\(/);
  assert.doesNotMatch(block, /syncAppliedCalibration\(\)/);
});

test('server composition retains concrete Source seek lifecycle effects', () => {
  const composition = variableInitializerCode(mapping, 'seek');
  assert.match(composition, /^createRelaySourceSeekTransactionCoordinator<CalibrationContext>\(\{/);
  assert.match(composition, /resetPlayerOffset: \(\) => dependencies\.offset\.reset\(\)/);
  assert.match(composition, /beginContentTransition: \(fromMediaTime, toMediaTime, preDeltaMs, referenceDeltaMs, context, nowMs\) => \{/);
  assert.match(composition, /mapping\.beginTransition\(fromMediaTime, toMediaTime, preDeltaMs, referenceDeltaMs, context, nowMs\)/);
  assert.match(composition, /syncAppliedCalibration: \(\) => \{ dependencies\.effects\.syncAppliedCalibration\(\); \}/);
  // The destructive branch's teardown is the server's one revocation
  // transaction, not a checklist re-spelled per call site.
  assert.match(composition, /revokeContentMapping: \(reason\) => mapping\.revoke\(reason\)/);
  const root = functionCode(mapping, 'createRelayRobotMappingOrchestration');
  assert.match(root, /beginTransition: lifecycle\.beginTransition/);
  assert.match(root, /revoke: lifecycle\.revoke/);
  for (const step of [
    /clearContentTransition:/,
    /invalidateSourceMapping:/,
    /clearContentValidation:/,
    /discardPrimedContent:/,
    /resetContentTimeline:/,
    /calibrationCollecting:/,
    /failCalibration:/,
  ]) {
    assert.doesNotMatch(composition, step, 'teardown steps belong to revokeRobotContentMapping');
  }
  assert.match(composition, /reportSourceStatus: \(\) => dependencies\.effects\.reportSourceStatus\(\)/);
  assert.match(composition, /reportTimingStatus: \(\) => dependencies\.effects\.reportTimingStatus\(\)/);
  const binding = variableInitializerCode(server, 'relayRobotMapping');
  assert.match(binding, /offset: robotPlayerOffset/);
  assert.match(binding, /reportSourceStatus: \(\) => broadcastJson\(sourceStatusPayload\(\)\)/);
  assert.match(binding, /reportTimingStatus: \(\) => broadcastJson\(timingCalibrationStatusPayload\(\)\)/);
});

test('Source seek coordinator owns no infrastructure, mapping or calibration authority', () => {
  const coordinatorCode = sourceCode(coordinator);
  assert.doesNotMatch(
    coordinatorCode,
    /from '\.\/(?:source-runtime|robot-content-timeline|robot-content-transition-runtime|calibration-session|timing-runtime)\.js'/,
  );
  assert.doesNotMatch(
    coordinatorCode,
    /InfrastructureCapabilityRuntime|SourceRuntime|RobotContentTimelineMapper|RobotContentTransitionRuntime|CalibrationSession/,
  );
});
