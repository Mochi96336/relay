import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const runtime = fs.readFileSync(path.join(root, 'src/backing-runtime.ts'), 'utf8');
const server = fs.readFileSync(path.join(root, 'src/server.ts'), 'utf8');

test('BackingRuntime owns transport lifecycle without absorbing domain authority', () => {
  assert.doesNotMatch(runtime, /audio-session|calibration|timing-runtime|robot-content|robot-player|participant-session|song-session|take-controller|probe-lifecycle/);
  assert.match(server, /new BackingRuntime<RelaySocket>/);
  assert.match(server, /backingRuntime\.bind\(/);
  assert.match(server, /backingRuntime\.detach\(/);
  assert.match(server, /backingRuntime\.armed\(\)/);

  assert.doesNotMatch(server, /let backing: RelaySocket \| null/);
  assert.doesNotMatch(server, /let backingSampleRate: number \| null/);
  assert.doesNotMatch(server, /let backingIsRobot =/);
  assert.doesNotMatch(server, /let lastBackingFrameAt =/);
  assert.doesNotMatch(server, /backingAbsenceTimer/);

  // Grace expiry still delegates product/domain policy back to server.ts.
  assert.match(server, /onGraceExpired: expireBackingGrace/);
  assert.match(server, /function expireBackingGrace\(\)/);
  assert.match(server, /invalidateMicTiming\('Backing route ended while the room continued voice-only\.'\)/);
});
