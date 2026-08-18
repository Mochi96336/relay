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

test('the recovery adapter is installed before youtube-sync constructs its playback socket', async () => {
  const trigger = await readFile(new URL('../public/playback-prewarm-trigger.js', import.meta.url), 'utf8');
  const source = await readFile(new URL('../public/playback-handoff-reconnect-recovery.js', import.meta.url), 'utf8');

  assert.match(trigger, /import '\.\/playback-handoff-reconnect-recovery\.js'/);
  assert.match(source, /window\.WebSocket = new Proxy\(NativeWebSocket/);
  assert.match(source, /message\?\.type === 'playback-hello'/);
  assert.match(source, /playbackSocket\.dispatchEvent\(new MessageEvent\('message'/,
    'recovered terminals must pass through youtube-sync instead of bypassing its private handoff state');
});
