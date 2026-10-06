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
const mapping = parseTypeScriptSource(new URL('../src/relay-robot-mapping-orchestration.ts', import.meta.url),
  readFileSync(new URL('../src/relay-robot-mapping-orchestration.ts', import.meta.url), 'utf8'));

test('legacy Robot calibration drop delegates through one coordinator seam', () => {
  const drop = functionCode(server, 'dropLegacyCalibrationForRobot');

  assert.match(drop, /relayRobotMapping\.dropLegacyCalibration\(\)/);
  assert.doesNotMatch(
    drop,
    /clearContentValidationBaseline\(|calibration\.reset\(|timingRuntime\.clearCalibrationKind\(|timingRuntime\.resetAutoCalibrationSchedule\(|syncAppliedCalibration\(/,
  );
});

test('server composition retains Robot, probe, calibration, timing, and mixer authorities', () => {
  assert.ok(
    importSources(mapping).includes('./relay-robot-legacy-calibration-drop-coordinator.js'),
  );
  const composition = variableInitializerCode(mapping, 'legacyDrop');
  assert.match(composition, /^createRelayRobotLegacyCalibrationDropCoordinator\(\{/);
  assert.match(composition, /robotRouteActive: \(\) => mapping\.routeActive\(\)/);
  assert.match(composition, /calibrationKind: \(\) => dependencies\.timing\.calibrationKind/);
  assert.match(composition, /bootProbeSettled: \(\) => dependencies\.queries\.bootProbeSettled\(\)/);
  assert.match(
    composition,
    /clearContentValidationBaseline: \(\) => dependencies\.effects\.clearContentValidation\(\)/,
  );
  assert.match(composition, /resetCalibration: \(\) => dependencies\.calibration\.reset\(\)/);
  assert.match(
    composition,
    /clearCalibrationKind: \(\) => dependencies\.timing\.clearCalibrationKind\(\)/,
  );
  assert.match(
    composition,
    /resetAutoCalibrationSchedule: \(\) => dependencies\.timing\.resetAutoCalibrationSchedule\(\)/,
  );
  assert.match(
    composition,
    /syncAppliedCalibration: \(\) => \{ dependencies\.effects\.syncAppliedCalibration\(\); \}/,
  );
  const binding = variableInitializerCode(server, 'relayRobotMapping');
  for (const canonical of ['timing: timingRuntime', 'calibration,', 'bootProbeSettled,',
    'clearContentValidation: clearContentValidationBaseline']) assert.ok(binding.includes(canonical));
  assert.match(binding, /syncAppliedCalibration: \(\) => \{ syncAppliedCalibration\(\); \}/);
});

test('legacy calibration drop coordinator owns transaction policy, not runtime authority', () => {
  const code = sourceCode(coordinator);
  assert.doesNotMatch(code, /^import /m);
  assert.doesNotMatch(
    code,
    /bootProbeRuntime\.|timingRuntime\.|calibration\.|session\.|BootProbeRuntime|TimingRuntime|CalibrationSession|AudioSession/,
  );
});
