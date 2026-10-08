import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { objectArrowCallbackCode, parseTypeScriptSource } from './support/source-contract.js';

const server = parseTypeScriptSource(
  new URL('../src/server.ts', import.meta.url),
  readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'),
);

test('Backing registration keeps infrastructure admission, validation and role commit in server', () => {
  const backing = objectArrowCallbackCode(server, 'registrationProtocol', 'backing');
  assert.match(backing, /infrastructureCapability\.authorized\(socket\)/);
  assert.match(backing, /canClaimSocketRole\(socket, 'backing'\)/);
  assert.match(backing, /validSampleRate\(payload\.sampleRate\)/);
  assert.match(backing, /commitSocketRole\(socket, 'backing'\)/);
  assert.match(backing, /backingActivated\(socket, sampleRate, payload\.robot === true, captureReplaced\)/);

  assert.doesNotMatch(backing, /backingRuntime\.bind\(/);
  assert.doesNotMatch(backing, /replacePrevious\(/);
  assert.doesNotMatch(backing, /clearRobotContentTransition\(/);
  assert.doesNotMatch(backing, /takeController\.noteQualityEvent\('backing-transport/);
  assert.doesNotMatch(backing, /session\.setBackingExpected\(/);
  assert.doesNotMatch(backing, /dropLegacyCalibrationForRobot\(/);
  assert.doesNotMatch(backing, /startLiveSource\(/);
});
