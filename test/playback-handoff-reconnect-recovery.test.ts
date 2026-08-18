import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createPlaybackHandoffReconnectRecovery } from '../public/playback-handoff-reconnect-recovery.js';

const B = {
  participantId: 'participant-b',
  transportId: 'playback-tab-b',
  generation: 7,
};

function timeline(overrides: Record<string, unknown> = {}) {
  return {
    playbackLeaderParticipantId: B.participantId,
    playbackTransportId: B.transportId,
    playbackGeneration: B.generation,
    handoffState: 'idle',
    handoffId: null,
    ...overrides,
  };
}

function recoveryHarness() {
  const terminal: Array<Record<string, unknown>> = [];
  const recovery = createPlaybackHandoffReconnectRecovery((message: Record<string, unknown>) => {
    terminal.push(message);
  });
  return { recovery, terminal };
}

test('status alone never reconstructs playback completion without a real disconnect', () => {
  const { recovery, terminal } = recoveryHarness();
  recovery.notePrepare('handoff-1');
  recovery.noteCommit('handoff-1');

  assert.equal(recovery.noteTimeline(timeline(), B), false);
  assert.deepEqual(terminal, []);
});

test('the same committed playback transport recovers a lost complete after reconnect proof', () => {
  const { recovery, terminal } = recoveryHarness();
  recovery.notePrepare('handoff-1');
  recovery.noteCommit('handoff-1');
  recovery.noteSocketClosed();

  assert.equal(recovery.noteTimeline(timeline(), B), true);
  assert.deepEqual(terminal, [{
    type: 'song-handoff-complete',
    handoffId: 'handoff-1',
    recoveredAfterReconnect: true,
  }]);
  assert.equal(recovery.noteTimeline(timeline(), B), false, 'terminal recovery must be one-shot');
});

test('a replayed prepare proves the old handoff is still live and keeps the normal direct cutover', () => {
  const { recovery, terminal } = recoveryHarness();
  recovery.notePrepare('handoff-1');
  recovery.noteCommit('handoff-1');
  recovery.noteSocketClosed();
  recovery.notePrepare('handoff-1');

  assert.equal(recovery.noteTimeline(timeline(), B), false);
  assert.deepEqual(terminal, []);
});

test('fresh server authority reconstructs cancellation when the target never became leader', () => {
  const { recovery, terminal } = recoveryHarness();
  recovery.notePrepare('handoff-1');
  recovery.noteCommit('handoff-1');
  recovery.noteSocketClosed();

  assert.equal(recovery.noteTimeline(timeline({
    playbackLeaderParticipantId: 'participant-a',
    playbackTransportId: 'playback-tab-a',
    playbackGeneration: 2,
  }), B), true);
  assert.deepEqual(terminal, [{
    type: 'song-handoff-cancelled',
    handoffId: 'handoff-1',
    recoveredAfterReconnect: true,
  }]);
});

test('a newer handoff does not hide completion of the disconnected committed target', () => {
  const { recovery, terminal } = recoveryHarness();
  recovery.notePrepare('handoff-1');
  recovery.noteCommit('handoff-1');
  recovery.noteSocketClosed();

  assert.equal(recovery.noteTimeline(timeline({
    handoffState: 'preparing',
    handoffId: 'handoff-2',
  }), B), true);
  assert.equal(terminal[0]?.type, 'song-handoff-complete');
});

test('the same still-active handoff is never inferred terminal from timeline status', () => {
  const { recovery, terminal } = recoveryHarness();
  recovery.notePrepare('handoff-1');
  recovery.noteCommit('handoff-1');
  recovery.noteSocketClosed();

  assert.equal(recovery.noteTimeline(timeline({
    handoffState: 'committing',
    handoffId: 'handoff-1',
  }), B), false);
  assert.deepEqual(terminal, []);
});

test('youtube-sync owns reconnect recovery without global WebSocket interception', async () => {
  const sync = await readFile(new URL('../public/youtube-sync.js', import.meta.url), 'utf8');
  const role = await readFile(new URL('../public/song-role.js', import.meta.url), 'utf8');
  const source = await readFile(new URL('../public/playback-handoff-reconnect-recovery.js', import.meta.url), 'utf8');

  assert.match(sync, /import \{ createPlaybackHandoffReconnectRecovery \} from '\.\/playback-handoff-reconnect-recovery\.js'/);
  assert.match(sync, /reconnectRecovery\.notePrepare\(handoffId\)/);
  assert.match(sync, /reconnectRecovery\.noteCommit\(activeHandoffId\)/);
  assert.match(sync, /reconnectRecovery\.noteSocketClosed\(\)/);
  assert.match(sync, /reconnectRecovery\.noteTimeline\(message, playbackIdentity\)/);
  assert.match(sync, /createPlaybackHandoffReconnectRecovery\(\(message\) => \{[\s\S]*handleServerMessage\(message\)/,
    'recovered terminals must re-enter youtube-sync through its normal parsed-message path');

  assert.doesNotMatch(role, /playback-handoff-reconnect-recovery/,
    'role resolution must stay pure and must not bootstrap transport side effects');
  assert.doesNotMatch(source, /window\.WebSocket|new Proxy\(|MessageEvent|playback-hello/,
    'the recovery state machine must not intercept page-global WebSocket construction or synthesize socket events');
});
