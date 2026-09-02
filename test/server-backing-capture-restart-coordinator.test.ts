import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const uplink = readFileSync(new URL('../src/relay-audio-uplink-coordinator.ts', import.meta.url), 'utf8');
const coordinator = readFileSync(
  new URL('../src/relay-backing-capture-restart-coordinator.ts', import.meta.url),
  'utf8',
);

test('audio uplink keeps Backing generation detection authority before restart effects', () => {
  assert.match(uplink, /const previousGeneration = options\.backingGeneration\(\);/);
  assert.match(uplink, /options\.ingestBacking\(frame, nowMs\)/);
  assert.match(
    uplink,
    /previousGeneration !== null[\s\S]*options\.backingGeneration\(\) !== previousGeneration[\s\S]*options\.onBackingCaptureRestarted\(\);/,
  );
});

test('server delegates only confirmed Backing restart effects through the coordinator seam', () => {
  assert.match(
    server,
    /onBackingCaptureRestarted: \(\) => \{\s*backingCaptureRestartCoordinator\.restart\(\{\s*calibrationCollecting: calibration\.collecting,\s*\}\);\s*\}/,
  );
  const start = server.indexOf('  onBackingCaptureRestarted: () => {');
  const end = server.indexOf('\n  },\n  noteRobotTransitionBackingFrame:', start);
  assert.ok(start >= 0 && end > start);
  const block = server.slice(start, end);
  assert.doesNotMatch(block, /takeController\.|bootProbeRuntime\.|contentCalibrationValidator\./);
  assert.doesNotMatch(block, /calibration\.(?:fail|reset|apply|begin)/);
  assert.doesNotMatch(block, /clearRobotBackingBoundaryRequest\(|broadcastJson\(|(?:^|[^.])syncAppliedCalibration\(/m);
});

test('server composition retains every Backing capture restart domain effect', () => {
  assert.match(
    server,
    /import \{ createRelayBackingCaptureRestartCoordinator \} from '\.\/relay-backing-capture-restart-coordinator\.js';/,
  );
  assert.match(
    server,
    /const backingCaptureRestartCoordinator = createRelayBackingCaptureRestartCoordinator\(\{/,
  );
  assert.match(server, /clearBackingBoundaryRequest: \(\) => clearRobotBackingBoundaryRequest\(\)/);
  assert.match(server, /noteQualityEvent: \(event\) => takeController\.noteQualityEvent\(event\)/);
  assert.match(server, /abandonProbeRun: \(\) => abandonProbeRun\(\)/);
  assert.match(server, /clearContentValidation: \(\) => clearContentValidationBaseline\(\)/);
  assert.match(server, /failCalibration: \(message\) => calibration\.fail\(message\)/);
  assert.match(server, /syncAppliedCalibration: \(\) => \{ syncAppliedCalibration\(\); \}/);
  assert.match(
    server,
    /reportTimingStatus: \(\) => broadcastJson\(timingCalibrationStatusPayload\(\)\)/,
  );
  assert.match(server, /reportSourceStatus: \(\) => broadcastJson\(sourceStatusPayload\(\)\)/);
});

test('Backing capture restart coordinator owns ordering only, not runtime authority', () => {
  assert.doesNotMatch(coordinator, /^import /m);
  assert.doesNotMatch(
    coordinator,
    /\bsession\.|\btakeController\.|\bbootProbeRuntime\.|\bcontentCalibrationValidator\.|\btimingRuntime\.|\bbroadcastJson\b/,
  );
  assert.doesNotMatch(
    coordinator,
    /(?:^|[^A-Za-z0-9_.])calibration\.(?:collecting|fail|reset|apply|begin|status|observe)/m,
  );
});
