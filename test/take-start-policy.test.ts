import assert from 'node:assert/strict';
import test from 'node:test';

import { decideTakeStart, type TakeStartFacts } from '../src/take-start-policy.js';

const READY: TakeStartFacts = {
  sessionActive: true,
  timingCalibrationActive: false,
  songLoaded: true,
  voiceOnlyMicReady: false,
  roomBlocked: false,
  takeLifecycle: 'idle',
};

test('Take start policy preserves server rejection precedence', () => {
  assert.deepEqual(
    decideTakeStart({
      ...READY,
      sessionActive: false,
      timingCalibrationActive: true,
      roomBlocked: true,
      takeLifecycle: 'recording',
    }),
    { ok: false, reason: 'mix-not-active' },
  );
  assert.deepEqual(
    decideTakeStart({
      ...READY,
      timingCalibrationActive: true,
      roomBlocked: true,
    }),
    { ok: false, reason: 'timing-calibration-active' },
  );
});

test('a voice-only Take requires a live Mic but ignores unused Robot health', () => {
  assert.deepEqual(
    decideTakeStart({ ...READY, songLoaded: false, voiceOnlyMicReady: false, roomBlocked: true }),
    { ok: false, reason: 'take-not-ready' },
  );
  assert.deepEqual(
    decideTakeStart({ ...READY, songLoaded: false, voiceOnlyMicReady: true, roomBlocked: true }),
    { ok: true },
  );
});

test('a Song Take preserves the existing backing-only recording path', () => {
  assert.deepEqual(
    decideTakeStart({ ...READY, songLoaded: true, voiceOnlyMicReady: false }),
    { ok: true },
  );
  assert.deepEqual(
    decideTakeStart({ ...READY, songLoaded: true, voiceOnlyMicReady: true }),
    { ok: true },
  );
});

test('a Song Take follows blocked product health even when the mix is still alive', () => {
  assert.deepEqual(
    decideTakeStart({ ...READY, roomBlocked: true }),
    { ok: false, reason: 'take-not-ready' },
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
