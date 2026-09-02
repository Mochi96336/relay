import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');

function functionBlock(name: string) {
  const match = server.match(new RegExp(`function ${name}\\([^]*?\\n\\}`));
  return match?.[0] ?? '';
}

test('manual Robot recalibration is explicit and does not masquerade as the automatic path', () => {
  const restart = functionBlock('restartManualBootCalibration');
  assert.ok(restart);
  assert.match(restart, /manualBootRecalibrationCoordinator\.restart\(nowMs\)/);
  assert.doesNotMatch(restart, /automatic/);
  assert.doesNotMatch(restart, /calibration\.reset\(\)/);
  assert.doesNotMatch(restart, /clearBootCalibrationState\(\)/);
  assert.doesNotMatch(server, /function restartBootCalibration\(/);

  const start = server.indexOf('const manualBootRecalibrationCoordinator =');
  const end = server.indexOf('function restartManualBootCalibration', start);
  assert.ok(start >= 0 && end > start, 'manual recalibration composition must remain identifiable');
  const composition = server.slice(start, end);
  assert.match(composition, /beginExternalRecalibration: \(\) => calibration\.beginExternalRecalibration\(\)/);
  assert.match(composition, /beginManualBootProbe: \(\) => timingRuntime\.beginBootProbe\(false\)/);
  assert.match(composition, /abandonProbeRun: \(\) => abandonProbeRun\(\)/);
  assert.match(composition, /resetProbeCorrelations: \(\) => bootProbeRuntime\.resetCorrelations\(\)/);
  assert.match(composition, /syncAppliedCalibration: \(\) => syncAppliedCalibration\(\)/);
  assert.match(composition, /maybeStartProbeCalibration: \(nowMs\) => maybeStartProbeCalibration\(nowMs\)/);
});

test('automatic boot-probe remains owned by the probe request path', () => {
  const sendProbe = functionBlock('sendProbeRequest');
  assert.ok(sendProbe);
  assert.match(sendProbe, /timingRuntime\.beginBootProbe\(true\)/);
  assert.doesNotMatch(sendProbe, /restartManualBootCalibration\(/);
});
