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
  new URL('../src/relay-mic-timing-invalidation-coordinator.ts', import.meta.url),
  readFileSync(new URL('../src/relay-mic-timing-invalidation-coordinator.ts', import.meta.url), 'utf8'),
);

test('invalidateMicTiming delegates cross-runtime ordering through the coordinator seam', () => {
  const invalidation = functionCode(server, 'invalidateMicTiming');
  assert.match(invalidation, /micTimingInvalidationCoordinator\.invalidate\(message\)/);
  assert.doesNotMatch(invalidation, /clearBootCalibrationState\(/);
  assert.doesNotMatch(invalidation, /clearContentValidationBaseline\(/);
  assert.doesNotMatch(invalidation, /calibration\./);
  assert.doesNotMatch(invalidation, /timingRuntime\./);
  assert.doesNotMatch(invalidation, /syncAppliedCalibration\(/);
  assert.doesNotMatch(invalidation, /broadcastJson\(/);
});

test('server composition retains calibration policy and all timing invalidation effects', () => {
  assert.ok(importSources(server).includes('./relay-mic-timing-invalidation-coordinator.js'));
  const composition = variableInitializerCode(server, 'micTimingInvalidationCoordinator');
  assert.match(composition, /^createRelayMicTimingInvalidationCoordinator\(\{/);
  assert.match(composition, /clearBootCalibration: \(\) => clearBootCalibrationState\(\)/);
  assert.match(composition, /clearContentValidation: \(\) => clearContentValidationBaseline\(\)/);
  assert.match(composition, /invalidateCalibration: \(message\) => \{/);
  assert.match(composition, /if \(calibration\.collecting\) calibration\.fail\(message\)/);
  assert.match(composition, /else calibration\.reset\(\)/);
  assert.match(composition, /clearTimingKind: \(\) => timingRuntime\.clearCalibrationKind\(\)/);
  assert.match(
    composition,
    /resetAutoCalibrationSchedule: \(\) => timingRuntime\.resetAutoCalibrationSchedule\(\)/,
  );
  assert.match(composition, /syncAppliedCalibration: \(\) => \{ syncAppliedCalibration\(\); \}/);
  assert.match(
    composition,
    /reportTimingStatus: \(\) => broadcastJson\(timingCalibrationStatusPayload\(\)\)/,
  );
  assert.match(composition, /reportSourceStatus: \(\) => broadcastJson\(sourceStatusPayload\(\)\)/);
});

test('Mic timing invalidation coordinator owns ordering only, not runtime authority', () => {
  const coordinatorCode = sourceCode(coordinator);
  assert.doesNotMatch(coordinatorCode, /^import /m);
  assert.doesNotMatch(
    coordinatorCode,
    /calibration\.|timingRuntime\.|bootProbeRuntime\.|contentCalibrationValidator\.|session\.|broadcastJson|(?:^|[^.])syncAppliedCalibration\(/m,
  );
});
