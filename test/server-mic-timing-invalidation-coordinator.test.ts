import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const coordinator = readFileSync(
  new URL('../src/relay-mic-timing-invalidation-coordinator.ts', import.meta.url),
  'utf8',
);

function invalidateMicTimingBlock() {
  const start = server.indexOf('function invalidateMicTiming(message: string) {');
  const end = server.indexOf('\n}\n\nfunction refreshLiveMicNetworkCompensation', start);
  assert.ok(start >= 0 && end > start);
  return server.slice(start, end + 2);
}

test('invalidateMicTiming delegates cross-runtime ordering through the coordinator seam', () => {
  const invalidation = invalidateMicTimingBlock();
  assert.match(invalidation, /micTimingInvalidationCoordinator\.invalidate\(message\)/);
  assert.doesNotMatch(invalidation, /clearBootCalibrationState\(/);
  assert.doesNotMatch(invalidation, /clearContentValidationBaseline\(/);
  assert.doesNotMatch(invalidation, /calibration\./);
  assert.doesNotMatch(invalidation, /timingRuntime\./);
  assert.doesNotMatch(invalidation, /syncAppliedCalibration\(/);
  assert.doesNotMatch(invalidation, /broadcastJson\(/);
});

test('server composition retains calibration policy and all timing invalidation effects', () => {
  assert.match(
    server,
    /import \{ createRelayMicTimingInvalidationCoordinator \} from '\.\/relay-mic-timing-invalidation-coordinator\.js';/,
  );
  assert.match(
    server,
    /const micTimingInvalidationCoordinator = createRelayMicTimingInvalidationCoordinator\(\{/,
  );
  assert.match(server, /clearBootCalibration: \(\) => clearBootCalibrationState\(\)/);
  assert.match(server, /clearContentValidation: \(\) => clearContentValidationBaseline\(\)/);
  assert.match(server, /invalidateCalibration: \(message\) => \{/);
  assert.match(server, /if \(calibration\.collecting\) calibration\.fail\(message\)/);
  assert.match(server, /else calibration\.reset\(\)/);
  assert.match(server, /clearTimingKind: \(\) => timingRuntime\.clearCalibrationKind\(\)/);
  assert.match(
    server,
    /resetAutoCalibrationSchedule: \(\) => timingRuntime\.resetAutoCalibrationSchedule\(\)/,
  );
  assert.match(server, /syncAppliedCalibration: \(\) => \{ syncAppliedCalibration\(\); \}/);
  assert.match(
    server,
    /reportTimingStatus: \(\) => broadcastJson\(timingCalibrationStatusPayload\(\)\)/,
  );
  assert.match(server, /reportSourceStatus: \(\) => broadcastJson\(sourceStatusPayload\(\)\)/);
});

test('Mic timing invalidation coordinator owns ordering only, not runtime authority', () => {
  assert.doesNotMatch(coordinator, /^import /m);
  assert.doesNotMatch(
    coordinator,
    /calibration\.|timingRuntime\.|bootProbeRuntime\.|contentCalibrationValidator\.|session\.|broadcastJson|(?:^|[^.])syncAppliedCalibration\(/m,
  );
});
