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
  new URL('../src/boot-probe-reapplication.ts', import.meta.url),
  readFileSync(new URL('../src/boot-probe-reapplication.ts', import.meta.url), 'utf8'),
);

test('server keeps Robot and Take hard guards while delegating boot reapply policy', () => {
  assert.ok(importSources(server).includes('./boot-probe-reapplication.js'));
  const reapply = functionCode(server, 'maybeReapplyBootCalibration');

  const takeGuard = reapply.indexOf('if (takeBlocksCalibration()) return;');
  const routeGuard = reapply.indexOf('if (!robotRouteActive()) return;');
  const decisionCall = reapply.indexOf('decideBootProbeReapplication({');
  assert.ok(takeGuard >= 0 && routeGuard > takeGuard && decisionCall > routeGuard);

  assert.match(reapply, /appliedKind/);
  assert.match(
    reapply,
    /replacementApplicability: appliedKind === 'boot-probe'[\s\S]*?\? null[\s\S]*?: calibrationApplicability\(appliedKind\)/,
  );
  assert.match(reapply, /roomHasSong: roomHasSong\(nowMs\)/);
  assert.match(reapply, /pathDifferenceReady: bootProbeRuntime\.pathDifferenceMs !== null/);
  assert.match(reapply, /calibrationCollecting: calibration\.collecting/);
  assert.match(reapply, /calibrationTransactionActive: calibration\.transactionActive/);
  assert.match(reapply, /robotDeltaFresh: robotDeltaIsFresh\(nowMs\)/);
  assert.match(
    reapply,
    /completedContextMatches: bootProbeRuntime\.completedContextMatches\(bootProbeContext\(\)\)/,
  );
  assert.match(reapply, /advanceMs: bootProbeAdvanceMs\(nowMs\)/);
  assert.match(reapply, /appliedMicLagMs: applied/);
  assert.match(reapply, /reapplyThresholdMs: BOOT_DELTA_REAPPLY_MS/);
  assert.match(reapply, /if \(decision\.kind === 'none'\) return;/);

  assert.doesNotMatch(reapply, /const reclaiming/);
  assert.doesNotMatch(reapply, /Math\.abs\(advanceMs - applied\) < BOOT_DELTA_REAPPLY_MS/);
});

test('server retains rate arithmetic, mutation, promotion ordering, and debug effects', () => {
  const reapply = functionCode(server, 'maybeReapplyBootCalibration');
  const advance = functionCode(server, 'bootProbeAdvanceMs');

  assert.match(
    advance,
    /mediaToWallMs\(currentDeltaMs\(nowMs\), currentPlaybackRate\(nowMs\)\)/,
  );
  assert.match(reapply, /const advanceMs = decision\.advanceMs/);
  assert.match(
    reapply,
    /decision\.reason === 'reclaim' \? 'reclaimed by boot baseline' : 'delta moved'/,
  );
  assert.match(
    reapply,
    /promoteBootProbeCalibration\([\s\S]*bootProbeRuntime\.reapplyCalibration\(advanceMs, currentDeltaMs\(nowMs\)\)[\s\S]*micLagMs: advanceMs[\s\S]*confidence: bootProbeRuntime\.confidence \?\? 0/,
  );
});

test('pure boot reapply policy owns no runtime or effect authority', () => {
  const code = sourceCode(policy);
  assert.doesNotMatch(code, /^import /m);
  assert.doesNotMatch(
    code,
    /bootProbeRuntime\.|timingRuntime\.|calibration\.|session\.|BootProbeRuntime|TimingRuntime|CalibrationSession|AudioSession/,
  );
});
