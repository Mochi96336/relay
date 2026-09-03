import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  importSources,
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

test('server retains Source seek authority and mapping classification before delegation', () => {
  assert.ok(importSources(server).includes('./relay-source-seek-transaction-coordinator.js'));
  const block = objectArrowCallbackCode(server, 'infrastructureEventProtocol', 'sourceSeeked');
  assert.match(block, /infrastructureCapability\.authorized\(socket\)/);
  assert.match(block, /sourceRuntime\.canReportSeek\(socket\)/);
  assert.match(block, /robotContentTransitionRuntime\.clearPendingBoundary\(\)/);
  assert.match(block, /payload\.reason === 'follower-correction'/);
  assert.match(block, /calibrationContext\(\)/);
  assert.match(block, /robotContentTimeline\.currentDeltaMs/);
  assert.match(block, /robotContentTimeline\.referenceDeltaMs/);
  assert.match(block, /robotContentTimeline\.noteFollowerCorrection\(/);
  assert.match(block, /sourceSeekTransactionCoordinator\.handle\(\{/);

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
  const composition = variableInitializerCode(server, 'sourceSeekTransactionCoordinator');
  assert.match(composition, /^createRelaySourceSeekTransactionCoordinator<CalibrationContext>\(\{/);
  assert.match(composition, /resetPlayerOffset: \(\) => robotPlayerOffset\.reset\(\)/);
  assert.match(composition, /beginContentTransition: \(fromMediaTime, toMediaTime, preDeltaMs, referenceDeltaMs, context, nowMs\) => \{/);
  assert.match(composition, /beginRobotContentTransition\(/);
  assert.match(composition, /syncAppliedCalibration: \(\) => \{ syncAppliedCalibration\(\); \}/);
  assert.match(composition, /clearContentTransition: \(\) => clearRobotContentTransition\(\)/);
  assert.match(composition, /invalidateSourceMapping: \(\) => sourceRuntime\.invalidateMapping\(\)/);
  assert.match(composition, /clearContentValidation: \(\) => clearContentValidationBaseline\(\)/);
  assert.match(composition, /discardPrimedContent: \(\) => calibration\.discardPrimedContent\(\)/);
  assert.match(composition, /resetContentTimeline: \(\) => robotContentTimeline\.reset\(\)/);
  assert.match(composition, /calibrationCollecting: \(\) => calibration\.collecting/);
  assert.match(composition, /failCalibration: \(message\) => calibration\.fail\(message\)/);
  assert.match(composition, /reportSourceStatus: \(\) => broadcastJson\(sourceStatusPayload\(\)\)/);
  assert.match(composition, /reportTimingStatus: \(\) => broadcastJson\(timingCalibrationStatusPayload\(\)\)/);
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
