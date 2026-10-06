import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { functionCode, hasFunction, parseTypeScriptSource } from './support/source-contract.js';

const server = parseTypeScriptSource(
  new URL('../src/server.ts', import.meta.url),
  readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'),
);

test('manual Robot recalibration is explicit and does not masquerade as the automatic path', () => {
  const restart = functionCode(server, 'restartManualBootCalibration');
  assert.match(restart, /relayCalibrationLifecycle\.restartManualBootCalibration\(nowMs\)/);
  const application = parseTypeScriptSource(new URL('../src/relay-calibration-orchestration.ts', import.meta.url),
    readFileSync(new URL('../src/relay-calibration-orchestration.ts', import.meta.url), 'utf8'));
  assert.match(functionCode(application, 'restartManualBootCalibration'), /manualBootRecalibrationCoordinator\.restart\(nowMs\)/);
  assert.doesNotMatch(restart, /automatic/);
  assert.doesNotMatch(restart, /calibration\.reset\(\)/);
  assert.doesNotMatch(restart, /clearBootCalibrationState\(\)/);
  assert.equal(hasFunction(server, 'restartBootCalibration'), false);
});

test('automatic boot-probe remains owned by the probe request path', () => {
  const workflow = parseTypeScriptSource(new URL('../src/relay-boot-probe-orchestration.ts', import.meta.url),
    readFileSync(new URL('../src/relay-boot-probe-orchestration.ts', import.meta.url), 'utf8'));
  const sendProbe = functionCode(workflow, 'sendProbeRequest');
  assert.match(sendProbe, /timingRuntime\.beginBootProbe\(true\)/);
  assert.doesNotMatch(sendProbe, /restartManualBootCalibration\(/);
});
