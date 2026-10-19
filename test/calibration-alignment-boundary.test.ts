import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { importSources, parseTypeScriptSource, sourceCode } from './support/source-contract.js';

function source(name: string) {
  const url = new URL(`../src/${name}.ts`, import.meta.url);
  return parseTypeScriptSource(url, readFileSync(url, 'utf8'));
}

const policies = [
  'calibration-applicability', 'calibration-mixer-application',
  'boot-probe-mixer-application', 'boot-probe-reapplication',
];

for (const name of policies) {
  test(`${name} remains a pure policy without runtime or effect authority`, () => {
    const code = sourceCode(source(name));
    assert.doesNotMatch(code, /^import /m);
    assert.doesNotMatch(code, /\b(?:TimingRuntime|CalibrationSession|BootProbeRuntime|AudioSession)\b/);
    assert.doesNotMatch(code, /\b(?:timingRuntime|calibration|bootProbe|session|robotPlayerOffset|robotContentTimeline|sourceRuntime)\s*\./);
  });
}

test('CalibrationAlignment owns application policy while server supplies physical authority', () => {
  const server = source('server');
  const alignment = source('calibration-alignment');
  const serverImports = importSources(server);
  const alignmentImports = importSources(alignment);
  assert.ok(serverImports.includes('./calibration-alignment.js'));
  for (const name of policies) {
    assert.equal(serverImports.includes(`./${name}.js`), false);
    assert.ok(alignmentImports.includes(`./${name}.js`));
  }
  assert.doesNotMatch(sourceCode(server), /let\s+appliedCalibrationAuthority\b/);
  for (const forbidden of ['ws', 'node:fs', 'node:worker_threads', './server.js', './source-runtime.js', './mic-runtime.js', './backing-runtime.js']) {
    assert.equal(alignmentImports.includes(forbidden), false, `alignment must not own ${forbidden}`);
  }
});
