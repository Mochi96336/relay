import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  functionCode,
  importSources,
  parseTypeScriptSource,
  sourceCode,
} from './support/source-contract.js';

const application = parseTypeScriptSource(
  new URL('../src/relay-calibration-orchestration.ts', import.meta.url),
  readFileSync(new URL('../src/relay-calibration-orchestration.ts', import.meta.url), 'utf8'),
);
const policy = parseTypeScriptSource(
  new URL('../src/calibration-applicability.ts', import.meta.url),
  readFileSync(new URL('../src/calibration-applicability.ts', import.meta.url), 'utf8'),
);

test('calibration orchestration samples calibration applicability facts once and delegates authority policy', () => {
  assert.ok(importSources(application).includes('./calibration-applicability.js'));
  const applicability = functionCode(application, 'calibrationApplicability');

  assert.match(applicability, /const nowMs = performance\.now\(\)/);
  assert.match(applicability, /const result = calibration\.result/);
  assert.match(applicability, /const status = calibration\.status\(\)/);
  assert.match(applicability, /return decideCalibrationApplicability\(\{/);
  assert.match(applicability, /kind/);
  assert.match(applicability, /hasResult: result !== null/);
  assert.match(applicability, /stale: result !== null && calibrationIsStale\(\)/);
  assert.match(applicability, /calibrationTransactionActive: calibration\.transactionActive/);
  assert.match(applicability, /calibrationProvisional: status\.provisional/);
  assert.match(applicability, /hasConfirmedResult: calibration\.confirmedResult !== null/);
  assert.match(applicability, /robotProbeTimingActive: queries\.robotProbeTimingActive\(\)/);
  assert.match(applicability, /bootProbeSettled: queries\.bootProbeSettled\(nowMs\)/);
  assert.match(applicability, /robotRouteActive: queries\.robotRouteActive\(\)/);
  assert.match(applicability, /robotSourceConnected: sourceRuntime\.connected\(\)/);
  assert.match(applicability, /roomHasSong: queries\.roomHasSong\(nowMs\)/);
  assert.match(applicability, /robotDeltaFresh: queries\.robotDeltaIsFresh\(nowMs\)/);
  assert.match(applicability, /robotDeltaEverEstablished: queries\.robotDeltaEverEstablished\(\)/);
  assert.match(applicability, /robotContentMappingReady: queries\.robotContentMappingReady\(nowMs\)/);

  assert.doesNotMatch(applicability, /retainingConfirmedAuthority/);
  assert.doesNotMatch(applicability, /return ['"](?:apply|hold|revoke)['"]/);
});

test('pure applicability policy owns no runtime or effect authority', () => {
  const code = sourceCode(policy);
  assert.doesNotMatch(code, /^import /m);
  assert.doesNotMatch(
    code,
    /calibration\.|timingRuntime\.|bootProbeRuntime\.|robotPlayerOffset\.|robotContentTimeline\.|sourceRuntime\.|session\.|CalibrationSession|TimingRuntime|BootProbeRuntime|AudioSession/,
  );
});
