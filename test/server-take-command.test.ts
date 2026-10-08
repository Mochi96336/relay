import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { objectArrowCallbackCode, parseTypeScriptSource } from './support/source-contract.js';

const server = parseTypeScriptSource(
  new URL('../src/server.ts', import.meta.url),
  readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'),
);

test('server keeps Take command admission in the handlers and the recording in its functions', () => {
  const start = objectArrowCallbackCode(server, 'commandProtocol', 'startTake');
  assert.match(start, /if \(!socket\.participantId\)/);
  assert.match(start, /productStatusPayload\(nowMs\)/);
  assert.match(start, /actions\.canStartTake/);
  assert.match(start, /rejectTakeCommand\(socket, 'start'/);
  assert.match(start, /startTakeAtFrame\(socket, socket\.participantId, commandWallClockMs, nowMs\)/);
  assert.doesNotMatch(start, /takeController\.start\(/);
  assert.doesNotMatch(start, /takeFrameBoundary\(/);
  assert.doesNotMatch(start, /takeSongSnapshot\(/);

  const stop = objectArrowCallbackCode(server, 'commandProtocol', 'stopTake');
  assert.match(stop, /if \(!socket\.participantId\)/);
  assert.match(stop, /TAKE_ID_PATTERN\.test\(takeId\)/);
  assert.match(stop, /rejectTakeCommand\(socket, 'stop'/);
  assert.match(stop, /stopTakeAtFrame\(socket, socket\.participantId, takeId, commandWallClockMs, nowMs\)/);
  assert.doesNotMatch(stop, /takeController\.stop\(/);
  assert.doesNotMatch(stop, /takeFrameBoundary\(/);
});
