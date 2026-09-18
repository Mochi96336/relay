import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  functionCode,
  importSources,
  parseTypeScriptSource,
  sourceCode,
} from './support/source-contract.js';

const server = parseTypeScriptSource(
  new URL('../src/server.ts', import.meta.url),
  readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'),
);
const policy = parseTypeScriptSource(
  new URL('../src/calibration-applicability.ts', import.meta.url),
  readFileSync(new URL('../src/calibration-applicability.ts', import.meta.url), 'utf8'),
);

test('server samples calibration applicability facts once and delegates authority policy', () => {
  assert.ok(importSources(server).includes('./calibration-applicability.js'));
  const applicability = functionCode(server, 'calibrationApplicability');

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
  assert.match(applicability, /robotProbeTimingActive: robotProbeTimingActive\(\)/);
  assert.match(applicability, /bootProbeSettled: bootProbeSettled\(nowMs\)/);
  assert.match(applicability, /robotRouteActive: robotRouteActive\(\)/);
  assert.match(applicability, /robotSourceConnected: sourceRuntime\.connected\(\)/);
  assert.match(applicability, /roomHasSong: roomHasSong\(nowMs\)/);
  assert.match(applicability, /robotDeltaFresh: robotDeltaIsFresh\(nowMs\)/);
  assert.match(applicability, /robotDeltaEverEstablished: robotDeltaEverEstablished\(\)/);
  assert.match(applicability, /robotContentMappingReady: robotContentMappingReady\(nowMs\)/);

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
