import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  functionCode,
  parseTypeScriptSource,
} from './support/source-contract.js';

const server = parseTypeScriptSource(
  new URL('../src/server.ts', import.meta.url),
  readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'),
);

test('boot-probe promotion mutates probe authority before synchronous calibration settlement', () => {
  const promotion = functionCode(server, 'promoteBootProbeCalibration');
  const mutate = promotion.indexOf('mutateProbe();');
  const timingAuthority = promotion.indexOf('timingRuntime.markBootProbeAuthority();', mutate);
  const apply = promotion.indexOf('calibration.applyExternalResult(result());', timingAuthority);

  assert.ok(mutate >= 0, 'boot-probe runtime mutation must stay explicit');
  assert.ok(timingAuthority > mutate, 'timing authority must be marked after the probe runtime mutation');
  assert.ok(
    apply > timingAuthority,
    'external calibration must settle only after probe and timing authority are coherent',
  );
});

test('terminal probe failure settles only after probe and timing authority agree', () => {
  const failure = functionCode(server, 'failProbeAttempt');
  const mutate = failure.indexOf('bootProbeRuntime.failAttempt(target, reason, nowMs)');
  const timingAuthority = failure.indexOf('timingRuntime.markBootProbeAuthority();', mutate);
  const settle = failure.indexOf('calibration.failPreservingPrimed(failure.message);', timingAuthority);

  assert.ok(mutate >= 0, 'terminal failure must begin with the authoritative probe mutation');
  assert.ok(timingAuthority > mutate, 'terminal failure must mark boot-probe timing authority after mutation');
  assert.ok(
    settle > timingAuthority,
    'failure settlement may synchronously publish only after probe and timing authority are coherent',
  );
});

test('fresh two-leg probe result delegates ordered promotion without duplicating settlement effects', () => {
  const finish = functionCode(server, 'maybeFinishProbeAnalysis');

  assert.match(
    finish,
    /promoteBootProbeCalibration\([\s\S]*bootProbeRuntime\.recordCalibration\(bootProbeContext\(\), result\)[\s\S]*micLagMs: result\.advanceMs[\s\S]*confidence: Math\.max\(0, Math\.min\(1, result\.confidence\)\)/,
  );
  assert.doesNotMatch(finish, /timingRuntime\.markBootProbeAuthority\(\)/);
  assert.doesNotMatch(finish, /calibration\.applyExternalResult\(/);
});

test('delta reapply reads probe confidence only through the ordered promotion seam', () => {
  const reapply = functionCode(server, 'maybeReapplyBootCalibration');

  assert.match(
    reapply,
    /promoteBootProbeCalibration\([\s\S]*bootProbeRuntime\.reapplyCalibration\(advanceMs, currentDeltaMs\(nowMs\)\)[\s\S]*micLagMs: advanceMs[\s\S]*confidence: bootProbeRuntime\.confidence \?\? 0/,
  );
  assert.doesNotMatch(reapply, /timingRuntime\.markBootProbeAuthority\(\)/);
  assert.doesNotMatch(reapply, /calibration\.applyExternalResult\(/);
});
