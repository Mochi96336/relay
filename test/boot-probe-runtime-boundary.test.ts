import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  importSources,
  parseTypeScriptSource,
  sourceCode,
  variableInitializerCode,
} from './support/source-contract.js';

const server = parseTypeScriptSource(
  new URL('../src/server.ts', import.meta.url),
  readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'),
);
const runtime = parseTypeScriptSource(
  new URL('../src/boot-probe-runtime.ts', import.meta.url),
  readFileSync(new URL('../src/boot-probe-runtime.ts', import.meta.url), 'utf8'),
);
const serverCode = sourceCode(server);
const runtimeCode = sourceCode(runtime);

test('BootProbeRuntime aggregates probe evidence without absorbing calibration or media authority', () => {
  assert.deepEqual(
    importSources(runtime).sort(),
    ['./boot-calibration.js', './probe-lifecycle.js'].sort(),
    'BootProbeRuntime may depend only on the probe state machine and boot-result type',
  );

  const construction = variableInitializerCode(server, 'bootProbeRuntime');
  assert.ok(construction.includes('new BootProbeRuntime({'));
  assert.doesNotMatch(serverCode, /const probeLifecycle = new ProbeLifecycle\(/);
  assert.doesNotMatch(serverCode, /let probeRequestId =/);
  assert.doesNotMatch(serverCode, /let measuredMicLeg:/);
  assert.doesNotMatch(serverCode, /let lastProbeCorrelation:/);
  assert.doesNotMatch(serverCode, /let lastProbeContext:/);
  assert.doesNotMatch(serverCode, /let lastBootCalibration:/);
  assert.doesNotMatch(serverCode, /let bootPathDifferenceMs:/);
  assert.doesNotMatch(serverCode, /let bootConfidence:/);

  // Signal analysis, combination and application remain orchestration/domain work.
  assert.ok(serverCode.includes('locateProbe('));
  assert.ok(serverCode.includes('combineBootCalibration('));
  assert.ok(serverCode.includes('calibration.applyExternalResult('));
  assert.ok(serverCode.includes('timingRuntime.markBootProbeAuthority()'));
  assert.doesNotMatch(
    runtimeCode,
    /locateProbe|combineBootCalibration|applyExternalResult|markBootProbeAuthority|AudioSession|CalibrationSession|TimingRuntime/,
  );
});
