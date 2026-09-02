import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const coordinator = readFileSync(
  new URL('../src/relay-live-source-stop-coordinator.ts', import.meta.url),
  'utf8',
);

function stopLiveSourceBlock() {
  const start = server.indexOf('function stopLiveSource() {');
  const end = server.indexOf('\n}\n\nfunction roomHasSong', start);
  assert.ok(start >= 0 && end > start);
  return server.slice(start, end + 2);
}

test('stopLiveSource delegates teardown ordering through the coordinator seam', () => {
  const stop = stopLiveSourceBlock();
  assert.match(stop, /liveSourceStopCoordinator\.stop\(\)/);
  assert.doesNotMatch(stop, /backingRuntime\./);
  assert.doesNotMatch(stop, /takeController\./);
  assert.doesNotMatch(stop, /clearBootCalibrationState\(/);
  assert.doesNotMatch(stop, /clearContentValidationBaseline\(/);
  assert.doesNotMatch(stop, /robotPlayerOffset\./);
  assert.doesNotMatch(stop, /robotContentTimeline\./);
  assert.doesNotMatch(stop, /clearRobotBackingBoundaryRequest\(/);
  assert.doesNotMatch(stop, /session\./);
  assert.doesNotMatch(stop, /calibration\./);
  assert.doesNotMatch(stop, /timingRuntime\./);
  assert.doesNotMatch(stop, /broadcastJson\(/);
  assert.doesNotMatch(stop, /broadcastStatus\(/);
});

test('server composition retains every live source teardown domain effect', () => {
  assert.match(
    server,
    /import \{ createRelayLiveSourceStopCoordinator \} from '\.\/relay-live-source-stop-coordinator\.js';/,
  );
  assert.match(server, /const liveSourceStopCoordinator = createRelayLiveSourceStopCoordinator\(\{/);
  assert.match(server, /cancelBackingGrace: \(\) => backingRuntime\.cancelGrace\(\)/);
  assert.match(server, /retireRobotRoute: \(\) => backingRuntime\.retireRobotRoute\(\)/);
  assert.match(server, /sessionActive: \(\) => session\.active/);
  assert.match(server, /endTakeMix: \(\) => takeController\.endMix\(\)/);
  assert.match(server, /clearBootCalibration: \(\) => clearBootCalibrationState\(\)/);
  assert.match(server, /clearContentValidation: \(\) => clearContentValidationBaseline\(\)/);
  assert.match(server, /resetRobotPlayerOffset: \(\) => robotPlayerOffset\.reset\(\)/);
  assert.match(server, /resetRobotContentTimeline: \(\) => robotContentTimeline\.reset\(\)/);
  assert.match(
    server,
    /clearRobotBackingBoundaryRequest: \(\) => clearRobotBackingBoundaryRequest\(\)/,
  );
  assert.match(server, /stopSession: \(\) => session\.stop\(\)/);
  assert.match(server, /resetCalibration: \(\) => calibration\.reset\(\)/);
  assert.match(server, /clearTimingKind: \(\) => timingRuntime\.clearCalibrationKind\(\)/);
  assert.match(
    server,
    /resetAutoCalibrationSchedule: \(\) => timingRuntime\.resetAutoCalibrationSchedule\(\)/,
  );
  assert.match(
    server,
    /reportTimingStatus: \(\) => broadcastJson\(timingCalibrationStatusPayload\(\)\)/,
  );
  assert.match(server, /reportSourceStatus: \(\) => broadcastJson\(sourceStatusPayload\(\)\)/);
  assert.match(server, /reportStatus: \(\) => broadcastStatus\(\)/);
});

test('live source stop coordinator owns ordering only, not server runtime authority', () => {
  assert.doesNotMatch(coordinator, /^import /m);
  assert.doesNotMatch(
    coordinator,
    /backingRuntime\.|session\.|takeController\.|calibration\.|timingRuntime\.|robotPlayerOffset\.|robotContentTimeline\.|broadcastJson|broadcastStatus\(/,
  );
});
