import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { functionCode, parseTypeScriptSource } from './support/source-contract.js';

const server = parseTypeScriptSource(
  new URL('../src/server.ts', import.meta.url),
  readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'),
);

test('fresh two-leg probe result is promoted through promoteBootProbeCalibration', () => {
  const finish = functionCode(server, 'maybeFinishProbeAnalysis');

  assert.match(
    finish,
    /promoteBootProbeCalibration\([\s\S]*bootProbeRuntime\.recordCalibration\(bootProbeContext\(\), result\)[\s\S]*micLagMs: result\.advanceMs[\s\S]*confidence: Math\.max\(0, Math\.min\(1, result\.confidence\)\)/,
  );
  assert.doesNotMatch(finish, /timingRuntime\.markBootProbeAuthority\(\)/);
  assert.doesNotMatch(finish, /calibration\.applyExternalResult\(/);
});

test('backing completion consumes Mic evidence through the BootProbeRuntime context boundary', () => {
  const finish = functionCode(server, 'maybeFinishProbeAnalysis');
  const consume = finish.indexOf('bootProbeRuntime.takeMicLegForContext({');
  const combine = finish.indexOf('combineBootCalibration({', consume);

  assert.match(
    finish,
    /bootProbeRuntime\.takeMicLegForContext\(\{\s*sessionGeneration: session\.generation,\s*micGeneration: session\.micGeneration,\s*micSourceRate: micRuntime\.sampleRate,\s*\}\)/,
  );
  assert.doesNotMatch(
    finish,
    /micLeg\.(?:sessionGeneration|micGeneration|micSourceRate)/,
    'Mic evidence provenance belongs to BootProbeRuntime rather than server field inspection',
  );
  assert.ok(consume >= 0);
  assert.ok(combine > consume, 'context-validated Mic evidence must be consumed before calibration combination');
});

test('delta reapply reads probe confidence only through promoteBootProbeCalibration', () => {
  const reapply = functionCode(server, 'maybeReapplyBootCalibration');

  assert.match(
    reapply,
    /promoteBootProbeCalibration\([\s\S]*bootProbeRuntime\.reapplyCalibration\(advanceMs, currentDeltaMs\(nowMs\)\)[\s\S]*micLagMs: advanceMs[\s\S]*confidence: bootProbeRuntime\.confidence \?\? 0/,
  );
  assert.doesNotMatch(reapply, /timingRuntime\.markBootProbeAuthority\(\)/);
  assert.doesNotMatch(reapply, /calibration\.applyExternalResult\(/);
});
