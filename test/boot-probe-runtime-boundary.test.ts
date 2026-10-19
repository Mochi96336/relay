import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { importSources, parseTypeScriptSource, sourceCode } from './support/source-contract.js';

function source(file: string) {
  const url = new URL(`../src/${file}.ts`, import.meta.url);
  return parseTypeScriptSource(url, readFileSync(url, 'utf8'));
}

test('BootProbeRuntime owns evidence and request state without absorbing calibration or media authority', () => {
  const runtime = source('boot-probe-runtime');
  assert.deepEqual(importSources(runtime).sort(), ['./boot-calibration.js', './probe-lifecycle.js'].sort());
  assert.doesNotMatch(sourceCode(runtime), /locateProbe|combineBootCalibration|applyExternalResult|markBootProbeAuthority|AudioSession|CalibrationSession|TimingRuntime/);
});

test('transport composition delegates boot transactions instead of accessing partial probe evidence', () => {
  const server = source('server');
  assert.ok(importSources(server).includes('./boot-probe-coordinator.js'));
  assert.equal(importSources(server).includes('./boot-probe-runtime.js'), false);
  for (const operation of ['locateProbe(', 'combineBootCalibration(', '.beginAnalysis(', '.takeMicLegForContext(']) {
    assert.equal(sourceCode(server).includes(operation), false, `${operation} belongs to the boot coordinator`);
  }
});

test('boot coordination consumes domain ports without owning physical transports or recording storage', () => {
  const imports = importSources(source('boot-probe-coordinator'));
  for (const forbidden of ['ws', './server.js', './relay-socket-server.js', './take-controller.js', './take-library.js']) {
    assert.equal(imports.includes(forbidden), false, `boot coordination must not own ${forbidden}`);
  }
  for (const policy of ['boot-probe-runtime', 'boot-probe-run-identity-policy', 'boot-probe-analysis-readiness-policy']) {
    assert.ok(imports.includes(`./${policy}.js`));
  }
});
