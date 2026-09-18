import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  functionCode,
  importSources,
  parseTypeScriptSource,
  sourceCode,
  variableInitializerCode,
} from './support/source-contract.js';

const server = parseTypeScriptSource(
  new URL('../src/server.ts', import.meta.url),
  readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'),
);
const coordinator = parseTypeScriptSource(
  new URL('../src/relay-robot-legacy-calibration-drop-coordinator.ts', import.meta.url),
  readFileSync(
    new URL('../src/relay-robot-legacy-calibration-drop-coordinator.ts', import.meta.url),
    'utf8',
  ),
);

test('legacy Robot calibration drop delegates through one coordinator seam', () => {
  const drop = functionCode(server, 'dropLegacyCalibrationForRobot');

  assert.match(drop, /robotLegacyCalibrationDropCoordinator\.drop\(\)/);
  assert.doesNotMatch(
    drop,
    /clearContentValidationBaseline\(|calibration\.reset\(|timingRuntime\.clearCalibrationKind\(|timingRuntime\.resetAutoCalibrationSchedule\(|syncAppliedCalibration\(/,
  );
});

test('server composition retains Robot, probe, calibration, timing, and mixer authorities', () => {
  assert.ok(
    importSources(server).includes('./relay-robot-legacy-calibration-drop-coordinator.js'),
  );
  const composition = variableInitializerCode(server, 'robotLegacyCalibrationDropCoordinator');
  assert.match(composition, /^createRelayRobotLegacyCalibrationDropCoordinator\(\{/);
  assert.match(composition, /robotRouteActive: \(\) => robotRouteActive\(\)/);
  assert.match(composition, /calibrationKind: \(\) => timingRuntime\.calibrationKind/);
  assert.match(composition, /bootProbeSettled: \(\) => bootProbeSettled\(\)/);
  assert.match(
    composition,
    /clearContentValidationBaseline: \(\) => clearContentValidationBaseline\(\)/,
  );
  assert.match(composition, /resetCalibration: \(\) => calibration\.reset\(\)/);
  assert.match(
    composition,
    /clearCalibrationKind: \(\) => timingRuntime\.clearCalibrationKind\(\)/,
  );
  assert.match(
    composition,
    /resetAutoCalibrationSchedule: \(\) => timingRuntime\.resetAutoCalibrationSchedule\(\)/,
  );
  assert.match(
    composition,
    /syncAppliedCalibration: \(\) => \{ syncAppliedCalibration\(\); \}/,
  );
});

test('legacy calibration drop coordinator owns transaction policy, not runtime authority', () => {
  const code = sourceCode(coordinator);
  assert.doesNotMatch(code, /^import /m);
  assert.doesNotMatch(
    code,
    /bootProbeRuntime\.|timingRuntime\.|calibration\.|session\.|BootProbeRuntime|TimingRuntime|CalibrationSession|AudioSession/,
  );
});
