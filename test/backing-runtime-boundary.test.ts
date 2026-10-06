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
const micLifecycle = parseTypeScriptSource(
  new URL('../src/relay-mic-lifecycle.ts', import.meta.url),
  readFileSync(new URL('../src/relay-mic-lifecycle.ts', import.meta.url), 'utf8'),
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
  // The room's unarmed-stop decision moved as a complete Mic lifecycle group;
  // it still queries the canonical Backing owner, never copied armed state.
  const unarmedStop = functionCode(micLifecycle, 'maybeStopLiveSourceWhenUnarmed');
  assert.match(unarmedStop, /backingRuntime\.armed\(\)/);
  const micComposition = variableInitializerCode(server, 'relayMicLifecycle');
  assert.match(micComposition, /backing:\s*backingRuntime/);

  assert.doesNotMatch(serverCode, /let backing: RelaySocket \| null/);
  assert.doesNotMatch(serverCode, /let backingSampleRate: number \| null/);
  assert.doesNotMatch(serverCode, /let backingIsRobot =/);
  assert.doesNotMatch(serverCode, /let lastBackingFrameAt =/);
  assert.doesNotMatch(serverCode, /backingAbsenceTimer/);

  // BackingRuntime owns only expiry timing; room-level consequences remain
  // outside the transport runtime behind the server adapter.
  assert.match(backingRuntime, /onGraceExpired:\s*expireBackingGrace/);
  const expireBackingGrace = functionCode(server, 'expireBackingGrace');
  assert.match(expireBackingGrace, /backingGraceExpiryCoordinator\.expire\(\{/);
  assert.doesNotMatch(expireBackingGrace, /backingRuntime\.retireRobotRoute\(\)/);
  assert.doesNotMatch(expireBackingGrace, /clearRobotContentTransition\(\)/);
  assert.doesNotMatch(expireBackingGrace, /invalidateMicTiming\(/);
  assert.doesNotMatch(expireBackingGrace, /broadcastStatus\(\)/);
});
