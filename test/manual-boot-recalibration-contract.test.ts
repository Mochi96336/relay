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
  assert.match(restart, /calibration\.beginExternalRecalibration\(\)/);
  assert.match(restart, /timingRuntime\.beginBootProbe\(false\)/);
  assert.match(restart, /abandonProbeRun\(\)/);
  assert.match(restart, /bootProbeRuntime\.resetCorrelations\(\)/);
  assert.match(restart, /syncAppliedCalibration\(\)/);
  assert.match(restart, /maybeStartProbeCalibration\(nowMs\)/);
  assert.doesNotMatch(restart, /automatic/);
  assert.doesNotMatch(restart, /calibration\.reset\(\)/);
  assert.doesNotMatch(restart, /clearBootCalibrationState\(\)/);
  assert.doesNotMatch(server, /function restartBootCalibration\(/);
});

test('automatic boot-probe remains owned by the probe request path', () => {
  const sendProbe = functionBlock('sendProbeRequest');
  assert.ok(sendProbe);
  assert.match(sendProbe, /timingRuntime\.beginBootProbe\(true\)/);
  assert.doesNotMatch(sendProbe, /restartManualBootCalibration\(/);
});
