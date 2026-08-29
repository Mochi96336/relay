import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const runtime = fs.readFileSync(path.join(root, 'src/boot-probe-runtime.ts'), 'utf8');
const server = fs.readFileSync(path.join(root, 'src/server.ts'), 'utf8');

function withoutComments(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

test('BootProbeRuntime aggregates probe evidence without absorbing calibration or media authority', () => {
  const imports = [...runtime.matchAll(/^import\s+(?:type\s+)?[\s\S]*?from\s+['"]([^'"]+)['"];?$/gm)]
    .map((match) => match[1]);
  assert.deepEqual(
    imports.sort(),
    ['./boot-calibration.js', './probe-lifecycle.js'].sort(),
    'BootProbeRuntime may depend only on the probe state machine and boot-result type',
  );

  assert.match(server, /new BootProbeRuntime\(\{/);
  assert.doesNotMatch(server, /const probeLifecycle = new ProbeLifecycle\(/);
  assert.doesNotMatch(server, /let probeRequestId =/);
  assert.doesNotMatch(server, /let measuredMicLeg:/);
  assert.doesNotMatch(server, /let lastProbeCorrelation:/);
  assert.doesNotMatch(server, /let lastProbeContext:/);
  assert.doesNotMatch(server, /let lastBootCalibration:/);
  assert.doesNotMatch(server, /let bootPathDifferenceMs:/);
  assert.doesNotMatch(server, /let bootConfidence:/);

  // Signal analysis, combination and application remain orchestration/domain work.
  assert.match(server, /locateProbe\(/);
  assert.match(server, /combineBootCalibration\(/);
  assert.match(server, /calibration\.applyExternalResult\(/);
  assert.match(server, /timingRuntime\.markBootProbeAuthority\(\)/);
  assert.doesNotMatch(
    withoutComments(runtime),
    /locateProbe|combineBootCalibration|applyExternalResult|markBootProbeAuthority|AudioSession|CalibrationSession|TimingRuntime/,
  );
});