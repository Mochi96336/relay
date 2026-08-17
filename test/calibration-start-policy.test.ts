import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decideCalibrationStart,
  type CalibrationStartFacts,
} from '../src/calibration-start-policy.js';

const READY: CalibrationStartFacts = {
  takeLifecycle: 'idle',
  calibrationActive: false,
  sessionActive: true,
  backingConnected: true,
  publisherControlConnected: true,
  backingStreaming: true,
  micStreaming: true,
  robotProbeTimingActive: false,
  timelineConnected: true,
  timelineState: 1,
};

test('calibration start policy preserves runtime rejection precedence', () => {
  assert.deepEqual(
    decideCalibrationStart({
      ...READY,
      takeLifecycle: 'recording',
      calibrationActive: true,
      sessionActive: false,
    }),
    { ok: false, reason: 'take-active' },
  );
  assert.deepEqual(
    decideCalibrationStart({ ...READY, calibrationActive: true, sessionActive: false }),
    { ok: false, reason: 'calibration-active' },
  );
  assert.deepEqual(
    decideCalibrationStart({ ...READY, publisherControlConnected: false, micStreaming: false }),
    { ok: false, reason: 'sources-not-connected' },
  );
  assert.deepEqual(
    decideCalibrationStart({ ...READY, backingStreaming: false }),
    { ok: false, reason: 'sources-not-streaming' },
  );
});

test('Robot probe calibration does not invent a phone-timeline requirement', () => {
  assert.deepEqual(
    decideCalibrationStart({
      ...READY,
      robotProbeTimingActive: true,
      timelineConnected: false,
      timelineState: null,
    }),
    { ok: true, mode: 'boot-probe' },
  );
});

test('content calibration requires the phone timeline to be playing', () => {
  assert.deepEqual(
    decideCalibrationStart({ ...READY, timelineConnected: false, timelineState: null }),
    { ok: false, reason: 'phone-not-playing' },
  );
  assert.deepEqual(
    decideCalibrationStart({ ...READY, timelineState: 2 }),
    { ok: false, reason: 'phone-not-playing' },
  );
  assert.deepEqual(decideCalibrationStart(READY), { ok: true, mode: 'content' });
});
