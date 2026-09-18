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
  new URL('../src/boot-probe-mixer-application.ts', import.meta.url),
  readFileSync(new URL('../src/boot-probe-mixer-application.ts', import.meta.url), 'utf8'),
);

test('server samples Boot Probe facts and delegates mixer application policy', () => {
  assert.ok(importSources(server).includes('./boot-probe-mixer-application.js'));

  const sync = functionCode(server, 'syncAppliedCalibration');
  assert.match(sync, /decideBootProbeMixerApplication\(\{/);
  assert.match(sync, /activeMicLagMs: active/);
  assert.match(sync, /roomHasSong: roomHasSong\(nowMs\)/);
  assert.match(sync, /applicability: calibrationApplicability\(calibrationKind\)/);
  assert.match(sync, /storedDeltaMs: bootProbeRuntime\.calibrationResult\?\.deltaMs \?\? null/);
  assert.match(sync, /currentDeltaMs: currentDeltaMs\(nowMs\)/);
  assert.match(sync, /if \(decision\.kind === 'hold'\) return false;/);
  assert.match(sync, /session\.setAlignment\(\{ calibratedMicLagMs: decision\.micLagMs \}\)/);

  assert.doesNotMatch(sync, /storedDeltaMs === undefined/);
  assert.doesNotMatch(sync, /Math\.abs\(storedDeltaMs - currentDelta\)/);
});

test('Boot Probe mixer policy owns no runtime or AudioSession authority', () => {
  const code = sourceCode(policy);
  assert.doesNotMatch(code, /^import /m);
  assert.doesNotMatch(
    code,
    /bootProbeRuntime\.|timingRuntime\.|calibration\.|session\.|BootProbeRuntime|TimingRuntime|CalibrationSession|AudioSession/,
  );
});
