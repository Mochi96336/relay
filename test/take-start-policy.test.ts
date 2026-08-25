import assert from 'node:assert/strict';
import test from 'node:test';

import { decideTakeStart, type TakeStartFacts } from '../src/take-start-policy.js';

const READY: TakeStartFacts = {
  sessionActive: true,
  timingCalibrationActive: false,
  songLoaded: true,
  voiceOnlyMicState: 'live',
  roomBlocked: false,
  takeLifecycle: 'idle',
};

test('active timing calibration remains the normal preparation reason', () => {
  assert.deepEqual(
    decideTakeStart({
      ...READY,
      sessionActive: false,
      timingCalibrationActive: true,
      roomBlocked: true,
      takeLifecycle: 'recording',
    }),
    { ok: false, reason: 'timing-calibration-active' },
  );
});

test('a Song room blocker outranks generic inactive mix state', () => {
  assert.deepEqual(
    decideTakeStart({
      ...READY,
      sessionActive: false,
      roomBlocked: true,
    }),
    { ok: false, reason: 'room-blocked' },
  );
});

test('a voice-only Take exposes the Mic state that blocks recording', () => {
  const expected = [
    ['free', 'mic-required'],
    ['starting', 'mic-starting'],
    ['reconnecting', 'mic-reconnecting'],
    ['interrupted', 'mic-audio-stalled'],
  ] as const;

  for (const [voiceOnlyMicState, reason] of expected) {
    assert.deepEqual(
      decideTakeStart({
        ...READY,
        songLoaded: false,
        voiceOnlyMicState,
        roomBlocked: true,
      }),
      { ok: false, reason },
    );
  }

  assert.deepEqual(
    decideTakeStart({
      ...READY,
      songLoaded: false,
      voiceOnlyMicState: 'live',
      roomBlocked: true,
    }),
    { ok: true },
  );
});

test('a live voice-only Mic still waits for the AudioSession when necessary', () => {
  assert.deepEqual(
    decideTakeStart({
      ...READY,
      songLoaded: false,
      voiceOnlyMicState: 'live',
      sessionActive: false,
    }),
    { ok: false, reason: 'mix-not-active' },
  );
});

test('a Song Take preserves the existing backing-only recording path', () => {
  assert.deepEqual(
    decideTakeStart({ ...READY, songLoaded: true, voiceOnlyMicState: 'free' }),
    { ok: true },
  );
  assert.deepEqual(
    decideTakeStart({ ...READY, songLoaded: true, voiceOnlyMicState: 'live' }),
    { ok: true },
  );
});

test('a Song Take exposes a room-level product blocker when health is blocked', () => {
  assert.deepEqual(
    decideTakeStart({ ...READY, roomBlocked: true }),
    { ok: false, reason: 'room-blocked' },
  );
});

test('recording and finalizing are the only Take lifecycles that block another start', () => {
  assert.deepEqual(
    decideTakeStart({ ...READY, takeLifecycle: 'recording' }),
    { ok: false, reason: 'take-active' },
  );
  assert.deepEqual(
    decideTakeStart({ ...READY, takeLifecycle: 'finalizing' }),
    { ok: false, reason: 'take-active' },
  );
  assert.deepEqual(decideTakeStart({ ...READY, takeLifecycle: 'ready' }), { ok: true });
  assert.deepEqual(decideTakeStart({ ...READY, takeLifecycle: 'failed' }), { ok: true });
});
