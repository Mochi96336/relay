import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  functionCode,
  parseTypeScriptSource,
  sourceCode,
  variableInitializerCode,
} from './support/source-contract.js';

const runtime = parseTypeScriptSource(
  new URL('../src/backing-runtime.ts', import.meta.url),
  readFileSync(new URL('../src/backing-runtime.ts', import.meta.url), 'utf8'),
);
const server = parseTypeScriptSource(
  new URL('../src/server.ts', import.meta.url),
  readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'),
);

test('BackingRuntime owns transport lifecycle without absorbing domain authority', () => {
  const runtimeCode = sourceCode(runtime);
  const serverCode = sourceCode(server);
  const backingRuntime = variableInitializerCode(server, 'backingRuntime');

  assert.doesNotMatch(
    runtimeCode,
    /audio-session|calibration|timing-runtime|robot-content|robot-player|participant-session|song-session|take-controller|probe-lifecycle/,
  );
  assert.match(backingRuntime, /^new BackingRuntime<RelaySocket>/);
  assert.match(serverCode, /backingRuntime\.bind\(/);
  assert.match(serverCode, /backingRuntime\.detach\(/);
  assert.match(serverCode, /backingRuntime\.armed\(\)/);

  assert.doesNotMatch(serverCode, /let backing: RelaySocket \| null/);
  assert.doesNotMatch(serverCode, /let backingSampleRate: number \| null/);
  assert.doesNotMatch(serverCode, /let backingIsRobot =/);
  assert.doesNotMatch(serverCode, /let lastBackingFrameAt =/);
  assert.doesNotMatch(serverCode, /backingAbsenceTimer/);

  // Grace expiry still delegates product/domain policy back to server.ts.
  assert.match(backingRuntime, /onGraceExpired:\s*expireBackingGrace/);
  const expireBackingGrace = functionCode(server, 'expireBackingGrace');
  assert.match(
    expireBackingGrace,
    /invalidateMicTiming\('Backing route ended while the room continued voice-only\.'\)/,
  );
});
