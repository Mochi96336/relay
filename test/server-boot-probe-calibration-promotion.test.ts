import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  functionCode,
  importSources,
  parseTypeScriptSource,
  sourceCode,
  variableInitializerCode,
} from './support/source-contract.js';

const server = parseTypeScriptSource(
  new URL('../src/server.ts', import.meta.url),
  readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'),
);
const coordinator = parseTypeScriptSource(
  new URL('../src/relay-boot-probe-calibration-promotion-coordinator.ts', import.meta.url),
  readFileSync(
    new URL('../src/relay-boot-probe-calibration-promotion-coordinator.ts', import.meta.url),
    'utf8',
  ),
);

test('boot-probe promotion delegates synchronous ordering through the coordinator seam', () => {
  const promotion = functionCode(server, 'promoteBootProbeCalibration');
  assert.match(
    promotion,
    /bootProbeCalibrationPromotionCoordinator\.promote\(mutateProbe, result\)/,
  );
  assert.doesNotMatch(promotion, /mutateProbe\(\)/);
  assert.doesNotMatch(promotion, /timingRuntime\./);
  assert.doesNotMatch(promotion, /calibration\.applyExternalResult\(/);
  assert.doesNotMatch(promotion, /result\(\)/);
});

test('server composition retains Boot Probe timing and calibration authorities', () => {
  assert.ok(
    importSources(server).includes('./relay-boot-probe-calibration-promotion-coordinator.js'),
  );
  const composition = variableInitializerCode(server, 'bootProbeCalibrationPromotionCoordinator');
  assert.match(composition, /^createRelayBootProbeCalibrationPromotionCoordinator\(\{/);
  assert.match(
    composition,
    /markBootProbeAuthority: \(\) => timingRuntime\.markBootProbeAuthority\(\)/,
  );
  assert.match(
    composition,
    /applyExternalResult: \(result\) => calibration\.applyExternalResult\(result\)/,
  );
});

test('Boot Probe promotion coordinator owns ordering only, not runtime authority', () => {
  const code = sourceCode(coordinator);
  assert.doesNotMatch(code, /^import /m);
  assert.doesNotMatch(
    code,
    /bootProbeRuntime\.|timingRuntime\.|calibration\.|BootProbeRuntime|TimingRuntime|CalibrationSession|AudioSession/,
  );
});

test('terminal probe failure reconciles candidate provenance before synchronous settlement', () => {
  const failure = functionCode(server, 'failProbeAttempt');
  const mutate = failure.indexOf('bootProbeRuntime.failAttempt(target, reason, nowMs)');
  const reconcile = failure.indexOf('timingRuntime.restoreCandidateKindToAuthority();', mutate);
  const settle = failure.indexOf('calibration.failPreservingPrimed(failure.message);', reconcile);

  assert.ok(mutate >= 0, 'terminal failure must begin with the authoritative probe mutation');
  assert.ok(
    reconcile > mutate,
    'terminal failure must reconcile candidate provenance after the probe runtime mutation',
  );
  assert.ok(
    settle > reconcile,
    'failure settlement may synchronously publish only after candidate and retained authority provenance agree',
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
