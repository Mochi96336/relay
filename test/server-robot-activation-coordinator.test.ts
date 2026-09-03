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
  new URL('../src/relay-robot-activation-coordinator.ts', import.meta.url),
  readFileSync(new URL('../src/relay-robot-activation-coordinator.ts', import.meta.url), 'utf8'),
);

test('Robot hello keeps infrastructure and SourceRuntime attach authority in server', () => {
  const hello = objectArrowCallbackCode(server, 'robotLifecycleProtocol', 'robotSourceHello');
  assert.match(hello, /infrastructureCapability\.authorized\(socket\)/);
  assert.match(hello, /sourceRuntime\.isActive\(socket\)/);
  assert.match(hello, /sourceRuntime\.attachRobot\(socket\)/);
  assert.match(hello, /robotActivationCoordinator\.activate\(\{ previous, replaced \}\)/);

  assert.doesNotMatch(hello, /takeController\.noteQualityEvent\(/);
  assert.doesNotMatch(hello, /abandonProbeRun\(\)/);
  assert.doesNotMatch(hello, /robotPlayerOffset\.reset\(\)/);
  assert.doesNotMatch(hello, /robotContentTimeline\.reset\(\)/);
  assert.doesNotMatch(hello, /clearRobotBackingBoundaryRequest\(\)/);
  assert.doesNotMatch(hello, /dropLegacyCalibrationForRobot\(\)/);
  assert.doesNotMatch(hello, /syncAppliedCalibration\(\)/);
  assert.doesNotMatch(hello, /broadcastJson\(/);
});

test('server composition retains Robot activation effects', () => {
  assert.ok(importSources(server).includes('./relay-robot-activation-coordinator.js'));
  const composition = variableInitializerCode(server, 'robotActivationCoordinator');
  assert.match(composition, /^createRelayRobotActivationCoordinator<RelaySocket>/);
  assert.match(composition, /type: 'robot-source-replaced'/);
  assert.match(composition, /takeController\.noteQualityEvent\(event\)/);
  assert.match(composition, /abandonProbeRun: \(\) => abandonProbeRun\(\)/);
  assert.match(composition, /sessionActive: \(\) => session\.active/);
  assert.match(composition, /resetPlayerOffset: \(\) => robotPlayerOffset\.reset\(\)/);
  assert.match(composition, /resetContentTimeline: \(\) => robotContentTimeline\.reset\(\)/);
  assert.match(composition, /clearBackingBoundaryRequest: \(\) => clearRobotBackingBoundaryRequest\(\)/);
  assert.match(composition, /dropLegacyCalibrationForRobot: \(\) => dropLegacyCalibrationForRobot\(\)/);
  assert.match(composition, /syncAppliedCalibration: \(\) => \{ syncAppliedCalibration\(\); \}/);
  assert.match(composition, /reportSourceStatus: \(\) => broadcastJson\(sourceStatusPayload\(\)\)/);
  assert.match(composition, /reportTimingStatus: \(\) => broadcastJson\(timingCalibrationStatusPayload\(\)\)/);
});

test('Robot activation coordinator owns ordering only, not source or timing authority', () => {
  const coordinatorCode = sourceCode(coordinator);
  assert.doesNotMatch(
    coordinatorCode,
    /from '\.\/(?:source-runtime|take-controller|audio-session|calibration-session)\.js'/,
  );
  assert.doesNotMatch(
    coordinatorCode,
    /infrastructureCapability\.|sourceRuntime\.|takeController\.|robotPlayerOffset\.|robotContentTimeline\.|\bsendJson\b|\bbroadcastJson\b/,
  );
});
