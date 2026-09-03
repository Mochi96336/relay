import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  topLevelFunctionSource,
  topLevelInitializerSource,
} from './helpers/source-boundary.js';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');

test('manual Robot recalibration is explicit and does not masquerade as the automatic path', () => {
  const restart = topLevelFunctionSource(server, 'restartManualBootCalibration');
  assert.match(restart, /manualBootRecalibrationCoordinator\.restart\(nowMs\)/);
  assert.doesNotMatch(restart, /automatic/);
  assert.doesNotMatch(restart, /calibration\.reset\(\)/);
  assert.doesNotMatch(restart, /clearBootCalibrationState\(\)/);
  assert.doesNotMatch(server, /function restartBootCalibration\(/);

  const composition = topLevelInitializerSource(server, 'manualBootRecalibrationCoordinator');
  assert.match(composition, /beginExternalRecalibration: \(\) => calibration\.beginExternalRecalibration\(\)/);
  assert.match(composition, /beginManualBootProbe: \(\) => timingRuntime\.beginBootProbe\(false\)/);
  assert.match(composition, /abandonProbeRun: \(\) => abandonProbeRun\(\)/);
  assert.match(composition, /resetProbeCorrelations: \(\) => bootProbeRuntime\.resetCorrelations\(\)/);
  assert.match(composition, /syncAppliedCalibration: \(\) => syncAppliedCalibration\(\)/);
  assert.match(composition, /maybeStartProbeCalibration: \(nowMs\) => maybeStartProbeCalibration\(nowMs\)/);
});

test('automatic boot-probe remains owned by the probe request path', () => {
  const sendProbe = topLevelFunctionSource(server, 'sendProbeRequest');
  assert.match(sendProbe, /timingRuntime\.beginBootProbe\(true\)/);
  assert.doesNotMatch(sendProbe, /restartManualBootCalibration\(/);
});
