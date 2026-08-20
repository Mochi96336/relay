import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldRestoreRoomAfterCommandTerminal } from '../public/room-song-command-terminal.js';

test('a chooser observer never restores media it did not apply', () => {
  assert.equal(shouldRestoreRoomAfterCommandTerminal({
    role: 'observer',
    trackedCommandId: 'command-shared-load',
    appliedCommandId: null,
  }), false);
});

test('the exact recovery target may restore its failed applied command', () => {
  assert.equal(shouldRestoreRoomAfterCommandTerminal({
    role: 'observer',
    trackedCommandId: 'command-recovery-load',
    appliedCommandId: 'command-recovery-load',
  }), true);
});

test('a holder restores a rejected native YouTube mutation', () => {
  assert.equal(shouldRestoreRoomAfterCommandTerminal({
    role: 'holder',
    trackedCommandId: 'command-native-seek',
    appliedCommandId: null,
  }), true);
});

test('an untracked broadcast never starts terminal recovery work', () => {
  assert.equal(shouldRestoreRoomAfterCommandTerminal({
    role: 'observer',
    trackedCommandId: null,
    appliedCommandId: 'command-someone-else',
  }), false);
});
