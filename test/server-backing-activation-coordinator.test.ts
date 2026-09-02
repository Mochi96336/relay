import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const coordinator = readFileSync(
  new URL('../src/relay-backing-activation-coordinator.ts', import.meta.url),
  'utf8',
);

function backingRegistrationBlock() {
  const registration = server.indexOf('const registrationProtocol = createRelayRegistrationProtocol<RelaySocket>({');
  const start = server.indexOf('backing: (socket, payload) => {', registration);
  const end = server.indexOf('monitor: (socket, payload) => {', start);
  assert.ok(registration >= 0 && start > registration && end > start);
  return server.slice(start, end);
}

test('Backing registration keeps infrastructure admission, validation and role commit in server', () => {
  const backing = backingRegistrationBlock();
  assert.match(backing, /infrastructureCapability\.authorized\(socket\)/);
  assert.match(backing, /canClaimSocketRole\(socket, 'backing'\)/);
  assert.match(backing, /validSampleRate\(payload\.sampleRate\)/);
  assert.match(backing, /commitSocketRole\(socket, 'backing'\)/);
  assert.match(backing, /backingActivationCoordinator\.activate\(\{/);

  assert.doesNotMatch(backing, /backingRuntime\.bind\(/);
  assert.doesNotMatch(backing, /replacePrevious\(/);
  assert.doesNotMatch(backing, /clearRobotBackingBoundaryRequest\(/);
  assert.doesNotMatch(backing, /takeController\.noteQualityEvent\('backing-transport/);
  assert.doesNotMatch(backing, /session\.setBackingExpected\(/);
  assert.doesNotMatch(backing, /dropLegacyCalibrationForRobot\(/);
  assert.doesNotMatch(backing, /startLiveSource\(/);
});

test('server composition retains Backing activation domain effects', () => {
  assert.match(
    server,
    /import \{ createRelayBackingActivationCoordinator \} from '\.\/relay-backing-activation-coordinator\.js';/,
  );
  assert.match(server, /const backingActivationCoordinator = createRelayBackingActivationCoordinator<RelaySocket>/);
  assert.match(server, /previousBacking: \(\) => backingRuntime\.socket/);
  assert.match(server, /clearRobotBackingBoundaryRequest: \(\) => clearRobotBackingBoundaryRequest\(\)/);
  assert.match(server, /takeController\.noteQualityEvent\(event\)/);
  assert.match(server, /replacePrevious\(previous, next, 'Replaced by a newer tab capture\.'\)/);
  assert.match(server, /socket\.sampleRate = sampleRate/);
  assert.match(server, /backingRuntime\.bind\(registration\)/);
  assert.match(server, /session\.setBackingExpected\(true\)/);
  assert.match(server, /sessionActive: \(\) => session\.active/);
  assert.match(server, /dropLegacyCalibrationForRobot: \(\) => dropLegacyCalibrationForRobot\(\)/);
  assert.match(server, /activeBackingIsRobot: \(\) => backingRuntime\.isRobot/);
  assert.match(server, /type: 'registered', role: 'backing', robot/);
  assert.match(server, /startLiveSource: \(\) => startLiveSource\(\)/);
});

test('Backing activation coordinator owns ordering only, not Relay runtimes or authority', () => {
  assert.doesNotMatch(
    coordinator,
    /from '\.\/(?:backing-runtime|audio-session|take-controller|infrastructure-capability-runtime)\.js'/,
  );
  assert.doesNotMatch(
    coordinator,
    /infrastructureCapability\.|backingRuntime\.|session\.|takeController\.|\bsendJson\b|\breplacePrevious\b/,
  );
});
