import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  importSources,
  objectArrowCallbackCode,
  parseTypeScriptSource,
  sourceCode,
  variableInitializerCode,
} from './support/source-contract.js';

const server = parseTypeScriptSource(
  new URL('../src/server.ts', import.meta.url),
  readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'),
);
const coordinator = parseTypeScriptSource(
  new URL('../src/relay-backing-activation-coordinator.ts', import.meta.url),
  readFileSync(new URL('../src/relay-backing-activation-coordinator.ts', import.meta.url), 'utf8'),
);

test('Backing registration keeps infrastructure admission, validation and role commit in server', () => {
  const backing = objectArrowCallbackCode(server, 'registrationProtocol', 'backing');
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
  assert.ok(importSources(server).includes('./relay-backing-activation-coordinator.js'));
  const composition = variableInitializerCode(server, 'backingActivationCoordinator');
  assert.match(composition, /^createRelayBackingActivationCoordinator<RelaySocket>/);
  assert.match(composition, /previousBacking: \(\) => backingRuntime\.socket/);
  assert.match(composition, /clearRobotBackingBoundaryRequest: \(\) => clearRobotBackingBoundaryRequest\(\)/);
  assert.match(composition, /takeController\.noteQualityEvent\(event\)/);
  assert.match(composition, /replacePrevious\(previous, next, 'Replaced by a newer tab capture\.'\)/);
  assert.match(composition, /socket\.sampleRate = sampleRate/);
  assert.match(composition, /backingRuntime\.bind\(registration\)/);
  assert.match(composition, /session\.setBackingExpected\(true\)/);
  assert.match(composition, /sessionActive: \(\) => session\.active/);
  assert.match(composition, /dropLegacyCalibrationForRobot: \(\) => dropLegacyCalibrationForRobot\(\)/);
  assert.match(composition, /activeBackingIsRobot: \(\) => backingRuntime\.isRobot/);
  assert.match(composition, /type: 'registered', role: 'backing', robot/);
  assert.match(composition, /startLiveSource: \(\) => startLiveSource\(\)/);
});

test('Backing activation coordinator owns ordering only, not Relay runtimes or authority', () => {
  const coordinatorCode = sourceCode(coordinator);
  assert.doesNotMatch(
    coordinatorCode,
    /from '\.\/(?:backing-runtime|audio-session|take-controller|infrastructure-capability-runtime)\.js'/,
  );
  assert.doesNotMatch(
    coordinatorCode,
    /infrastructureCapability\.|backingRuntime\.|session\.|takeController\.|\bsendJson\b|\breplacePrevious\b/,
  );
});
