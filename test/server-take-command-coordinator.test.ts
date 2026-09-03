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
  new URL('../src/relay-take-command-coordinator.ts', import.meta.url),
  readFileSync(new URL('../src/relay-take-command-coordinator.ts', import.meta.url), 'utf8'),
);

test('server keeps Take command admission authority and delegates admitted ordering', () => {
  assert.ok(importSources(server).includes('./relay-take-command-coordinator.js'));

  const start = objectArrowCallbackCode(server, 'commandProtocol', 'startTake');
  assert.match(start, /if \(!socket\.participantId\)/);
  assert.match(start, /productStatusPayload\(nowMs\)/);
  assert.match(start, /actions\.canStartTake/);
  assert.match(start, /rejectTakeCommand\(socket, 'start'/);
  assert.match(start, /takeCommandCoordinator\.start\(\{/);
  assert.doesNotMatch(start, /takeController\.start\(/);
  assert.doesNotMatch(start, /takeFrameBoundary\(/);
  assert.doesNotMatch(start, /takeSongSnapshot\(/);

  const stop = objectArrowCallbackCode(server, 'commandProtocol', 'stopTake');
  assert.match(stop, /if \(!socket\.participantId\)/);
  assert.match(stop, /TAKE_ID_PATTERN\.test\(takeId\)/);
  assert.match(stop, /rejectTakeCommand\(socket, 'stop'/);
  assert.match(stop, /takeCommandCoordinator\.stop\(\{/);
  assert.doesNotMatch(stop, /takeController\.stop\(/);
  assert.doesNotMatch(stop, /takeFrameBoundary\(/);
});

test('server composition retains TakeController and recording-domain effects', () => {
  const composition = variableInitializerCode(server, 'takeCommandCoordinator');
  assert.match(composition, /^createRelayTakeCommandCoordinator<\s*RelaySocket,/);
  assert.match(composition, /frameBoundary: \(nowMs\) => takeFrameBoundary\(nowMs\)/);
  assert.match(composition, /songSnapshot: \(atMs\) => takeSongSnapshot\(atMs\)/);
  assert.match(
    composition,
    /cancelActiveContentValidation: \(nowMs\) => cancelActiveContentValidation\(nowMs\)/,
  );
  assert.match(composition, /reportTimingStatus: \(\) => broadcastJson\(timingCalibrationStatusPayload\(\)\)/);
  assert.match(composition, /startTake: \(participantId, song, position, wallClockMs\) =>\s*takeController\.start\(participantId, song, position, wallClockMs\)/);
  assert.match(composition, /stopTake: \(takeId, participantId, position, reason, wallClockMs\) =>\s*takeController\.stop\(takeId, participantId, position, reason, wallClockMs\)/);
  assert.match(composition, /reject: \(socket, command, reason\) => rejectTakeCommand\(socket, command, reason\)/);
  assert.match(composition, /type: 'take-command-accepted'/);
});

test('Take command coordinator owns no TakeController, product or participant authority', () => {
  const coordinatorCode = sourceCode(coordinator);
  assert.doesNotMatch(
    coordinatorCode,
    /from '\.\/(?:take-controller|participant-session|product-view-model|audio-session)\.js'/,
  );
  assert.doesNotMatch(
    coordinatorCode,
    /TakeController|ParticipantSession|productStatusPayload|canStartTake|TAKE_ID_PATTERN/,
  );
});
