import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const coordinator = readFileSync(
  new URL('../src/relay-robot-activation-coordinator.ts', import.meta.url),
  'utf8',
);

function robotHelloBlock() {
  const lifecycle = server.indexOf('const robotLifecycleProtocol = createRelayRobotLifecycleProtocol<RelaySocket>({');
  const start = server.indexOf('robotSourceHello: (socket, payload) => {', lifecycle);
  const end = server.indexOf('\n  },\n});', start);
  assert.ok(lifecycle >= 0 && start > lifecycle && end > start);
  return server.slice(start, end);
}

test('Robot hello keeps infrastructure and SourceRuntime attach authority in server', () => {
  const hello = robotHelloBlock();
  assert.match(hello, /infrastructureCapability\.authorized\(socket\)/);
  assert.match(hello, /sourceRuntime\.isActive\(socket\)/);
  assert.match(hello, /sourceRuntime\.attachRobot\(socket\)/);
  assert.match(hello, /robotActivationCoordinator\.activate\(\{ previous, replaced \}\)/);

  assert.doesNotMatch(hello, /takeController\.noteQualityEvent\(/);
  assert.doesNotMatch(hello, /abandonProbeRun\(\)/);
  assert.doesNotMatch(hello, /robotPlayerOffset\.reset\(\)/);
  assert.doesNotMatch(hello, /robotContentTimeline\.reset\(\)/);
  assert.doesNotMatch(hello, /clearRobotBackingBoundaryRequest\(\)/);
  assert.doesNotMatch(hello, /dropLegacyCalibrationForRobot\(\)/);
  assert.doesNotMatch(hello, /syncAppliedCalibration\(\)/);
  assert.doesNotMatch(hello, /broadcastJson\(/);
});

test('server composition retains Robot activation effects', () => {
  assert.match(
    server,
    /import \{ createRelayRobotActivationCoordinator \} from '\.\/relay-robot-activation-coordinator\.js';/,
  );
  assert.match(server, /const robotActivationCoordinator = createRelayRobotActivationCoordinator<RelaySocket>/);
  assert.match(server, /type: 'robot-source-replaced'/);
  assert.match(server, /takeController\.noteQualityEvent\(event\)/);
  assert.match(server, /abandonProbeRun: \(\) => abandonProbeRun\(\)/);
  assert.match(server, /sessionActive: \(\) => session\.active/);
  assert.match(server, /resetPlayerOffset: \(\) => robotPlayerOffset\.reset\(\)/);
  assert.match(server, /resetContentTimeline: \(\) => robotContentTimeline\.reset\(\)/);
  assert.match(server, /clearBackingBoundaryRequest: \(\) => clearRobotBackingBoundaryRequest\(\)/);
  assert.match(server, /dropLegacyCalibrationForRobot: \(\) => dropLegacyCalibrationForRobot\(\)/);
  assert.match(server, /syncAppliedCalibration: \(\) => \{ syncAppliedCalibration\(\); \}/);
  assert.match(server, /reportSourceStatus: \(\) => broadcastJson\(sourceStatusPayload\(\)\)/);
  assert.match(server, /reportTimingStatus: \(\) => broadcastJson\(timingCalibrationStatusPayload\(\)\)/);
});

test('Robot activation coordinator owns ordering only, not source or timing authority', () => {
  assert.doesNotMatch(
    coordinator,
    /from '\.\/(?:source-runtime|take-controller|audio-session|calibration-session)\.js'/,
  );
  assert.doesNotMatch(
    coordinator,
    /infrastructureCapability\.|sourceRuntime\.|takeController\.|robotPlayerOffset\.|robotContentTimeline\.|\bsendJson\b|\bbroadcastJson\b/,
  );
});
