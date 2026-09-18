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
  new URL('../src/calibration-mixer-application.ts', import.meta.url),
  readFileSync(new URL('../src/calibration-mixer-application.ts', import.meta.url), 'utf8'),
);

test('server derives live calibration facts and delegates non-Boot mixer policy', () => {
  assert.ok(importSources(server).includes('./calibration-mixer-application.js'));

  const sync = functionCode(server, 'syncAppliedCalibration');
  assert.match(sync, /const applicability = calibrationApplicability\(calibrationKind\)/);
  assert.match(sync, /const robotContentAuthority = robotRouteActive\(\) && calibrationKind === 'content'/);
  assert.match(sync, /nextMicLagMs = contentLiveLagMs\(nextMicLagMs, performance\.now\(\)\)/);
  assert.match(sync, /decideCalibrationMixerApplication\(\{/);
  assert.match(sync, /activeMicLagMs: active/);
  assert.match(sync, /nextMicLagMs/);
  assert.match(sync, /hasContentValidationSlew: timingRuntime\.contentValidationSlewRevision !== null/);
  assert.match(sync, /contentValidationSlewMatchesRevision:\s*timingRuntime\.contentValidationSlewMatches\(calibration\.confirmedRevision\)/);
  assert.match(sync, /calibratedMicLagTarget: session\.calibratedMicLagTarget/);
  assert.match(sync, /jitterThresholdMs: BOOT_DELTA_REAPPLY_MS/);

  assert.match(sync, /if \(decision\.clearContentValidationSlew\) timingRuntime\.clearContentValidationSlew\(\)/);
  assert.match(sync, /if \(decision\.kind === 'none'\) return false/);
  assert.match(sync, /if \(decision\.kind === 'slew'\) return session\.slewCalibratedMicLagTo\(decision\.micLagMs\)/);
  assert.match(sync, /session\.setAlignment\(\{ calibratedMicLagMs: decision\.micLagMs \}\)/);

  assert.doesNotMatch(sync, /Math\.abs\(nextMicLagMs - active\) < BOOT_DELTA_REAPPLY_MS/);
  assert.doesNotMatch(sync, /session\.calibratedMicLagTarget === nextMicLagMs/);
});

test('general mixer policy owns no runtime or AudioSession authority', () => {
  const code = sourceCode(policy);
  assert.doesNotMatch(code, /^import /m);
  assert.doesNotMatch(
    code,
    /timingRuntime\.|calibration\.|session\.|TimingRuntime|CalibrationSession|AudioSession/,
  );
});
