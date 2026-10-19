import assert from 'node:assert/strict';
import test from 'node:test';

import { createTakeCommandHandlers } from '../src/take-command-handlers.js';
import type { StartTakeResult, StopTakeResult } from '../src/take-controller.js';
import type { TakeTimingAtStart } from '../src/take-quality.js';
import type { TakeRecord } from '../src/take-session.js';
import type { TakeStartBlockReason } from '../src/take-start-policy.js';

const SONG = { videoId: 'song', revision: 4, state: 1, serverTime: 12, playbackRate: 1 };
const POSITION = { generation: 7, firstSampleIndex: 20_160 };
const TIMING: TakeTimingAtStart = {
  appliedCalibrationKind: 'content', estimateSource: null, calibrationError: null,
};
const TAKE: TakeRecord = {
  takeId: 'take-1', lifecycle: 'finalizing', startedAtMs: 1_000, endedAtMs: 2_000,
  startedByParticipantId: 'singer', stoppedByParticipantId: 'listener', stopReason: 'user',
  song: SONG, artifact: null, mixSampleRange: null, quality: null, error: null,
};

function fixture() {
  const state = {
    wallTimeMs: 1_793_000_000_000,
    nowMs: 405.001,
    boundaryAtMs: 420,
    admission: { canStartTake: true, startTakeBlockedReason: null as TakeStartBlockReason | null },
    startResult: { ok: true, takeId: 'take-1' } as StartTakeResult,
    stopResult: { ok: true, take: TAKE, duplicate: false } as StopTakeResult,
    committed: false,
    backgroundRunning: true,
    timing: null as TakeTimingAtStart | null,
  };
  const calls: { name: string; args: unknown[] }[] = [];
  const replies: Record<string, unknown>[] = [];
  const socket: { participantId?: string } = { participantId: 'listener' };
  const handlers = createTakeCommandHandlers({
    controller: {
      start: (...args) => {
        calls.push({ name: 'start', args });
        state.committed = state.startResult.ok;
        return state.startResult;
      },
      stop: (...args) => { calls.push({ name: 'stop', args }); return state.stopResult; },
      noteTimingAtStart: (timing) => { state.timing = timing; return true; },
    },
    admission: (nowMs) => { calls.push({ name: 'admission', args: [nowMs] }); return state.admission; },
    frameBoundary: (nowMs) => {
      calls.push({ name: 'boundary', args: [nowMs] });
      return { position: POSITION, atMs: state.boundaryAtMs };
    },
    songAt: (nowMs) => { calls.push({ name: 'song', args: [nowMs] }); return SONG; },
    timingAtStart: (nowMs) => {
      assert.equal(nowMs, state.nowMs);
      assert.equal(state.committed, true, 'recording admission must succeed before provenance is saved');
      assert.equal(state.backgroundRunning, true, 'provenance must be captured before retiring its measurement');
      return TIMING;
    },
    onStarted: (nowMs) => {
      assert.equal(nowMs, state.nowMs);
      assert.equal(state.committed, true, 'a rejected command cannot stand down calibration');
      assert.deepEqual(state.timing, TIMING);
      state.backgroundRunning = false;
    },
    send: (target, message) => {
      assert.equal(target, socket);
      replies.push(message);
    },
    clock: {
      wallTime: () => state.wallTimeMs,
      monotonicTime: () => state.nowMs,
    },
  });
  return { state, calls, replies, socket, handlers };
}

test('anonymous recording commands cannot read room state, touch the controller or cancel calibration', () => {
  const f = fixture();
  delete f.socket.participantId;
  f.handlers.startTake(f.socket);
  f.handlers.stopTake(f.socket, { takeId: 'take-1' });
  assert.deepEqual(f.calls, []);
  assert.equal(f.state.backgroundRunning, true);
  assert.deepEqual(f.replies, [
    { type: 'take-command-rejected', command: 'start', reason: 'participant-required' },
    { type: 'take-command-rejected', command: 'stop', reason: 'participant-required' },
  ]);
});

for (const reason of ['timing-calibration-active', null] as const) {
  test(`product refusal (${reason}) leaves measurement and recording untouched`, () => {
    const f = fixture();
    f.state.admission = { canStartTake: false, startTakeBlockedReason: reason };
    f.handlers.startTake(f.socket);
    assert.deepEqual(f.calls, [{ name: 'admission', args: [f.state.nowMs] }]);
    assert.equal(f.state.backgroundRunning, true);
    assert.equal(f.state.timing, null);
    assert.deepEqual(f.replies, [{
      type: 'take-command-rejected', command: 'start', reason: reason ?? 'product-state-invalid',
    }]);
  });
}

test('Start snapshots the song at the next complete frame and translates its delay to wall time', () => {
  const f = fixture();
  f.handlers.startTake(f.socket);
  assert.deepEqual(f.calls.find((call) => call.name === 'start')?.args, [
    'listener', SONG, POSITION, f.state.wallTimeMs + (420 - 405.001),
  ]);
  assert.deepEqual(f.calls.find((call) => call.name === 'song')?.args, [420]);
  assert.equal(f.state.backgroundRunning, false);
  assert.deepEqual(f.state.timing, TIMING);
  assert.deepEqual(f.replies, [{ type: 'take-command-accepted', command: 'start', takeId: 'take-1' }]);
});

for (const reason of ['writer-failed', 'storage-unavailable', 'take-active', 'mix-boundary-invalid'] as const) {
  test(`controller refusal (${reason}) preserves background calibration and does not announce acceptance`, () => {
    const f = fixture();
    f.state.startResult = { ok: false, reason };
    f.handlers.startTake(f.socket);
    assert.equal(f.state.backgroundRunning, true);
    assert.equal(f.state.timing, null);
    assert.deepEqual(f.replies, [{ type: 'take-command-rejected', command: 'start', reason }]);
  });
}

test('invalid Stop identifiers never reach the frame clock or recording controller', () => {
  const f = fixture();
  for (const takeId of [undefined, null, 42, '', ' ', '../take', 'x/y', 'a'.repeat(129)]) {
    f.handlers.stopTake(f.socket, { takeId });
    assert.deepEqual(f.replies.at(-1), {
      type: 'take-command-rejected', command: 'stop', reason: 'invalid-take-id',
    });
  }
  assert.deepEqual(f.calls, []);
  assert.equal(f.state.backgroundRunning, true);
});

test('Stop uses its own command instant and works even when a new Take would be blocked', () => {
  const f = fixture();
  f.state.admission = { canStartTake: false, startTakeBlockedReason: 'take-active' };
  f.state.wallTimeMs += 10_000;
  f.state.nowMs = 1_003.25;
  f.state.boundaryAtMs = 1_020;
  f.handlers.stopTake(f.socket, { takeId: '  take-1  ' });
  assert.deepEqual(f.calls, [
    { name: 'boundary', args: [1_003.25] },
    { name: 'stop', args: ['take-1', 'listener', POSITION, 'user', f.state.wallTimeMs + 16.75] },
  ]);
  assert.equal(f.state.backgroundRunning, true);
  assert.deepEqual(f.replies, [{ type: 'take-command-accepted', command: 'stop', takeId: 'take-1', duplicate: false }]);
});

test('Stop preserves controller rejection and duplicate-command semantics', () => {
  const f = fixture();
  f.state.stopResult = { ok: false, reason: 'stale-take' };
  f.handlers.stopTake(f.socket, { takeId: 'old-take' });
  assert.deepEqual(f.replies.at(-1), { type: 'take-command-rejected', command: 'stop', reason: 'stale-take' });

  f.state.stopResult = { ok: true, take: TAKE, duplicate: true };
  f.handlers.stopTake(f.socket, { takeId: 'take-1' });
  assert.deepEqual(f.replies.at(-1), { type: 'take-command-accepted', command: 'stop', takeId: 'take-1', duplicate: true });
});
