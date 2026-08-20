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

test('calibration start policy preserves runtime rejection precedence and mode', () => {
  assert.deepEqual(
    decideCalibrationStart({
      ...READY,
      takeLifecycle: 'recording',
      calibrationActive: true,
      sessionActive: false,
    }),
    { ok: false, mode: 'content', reason: 'take-active' },
  );
  assert.deepEqual(
    decideCalibrationStart({ ...READY, calibrationActive: true, sessionActive: false }),
    { ok: false, mode: 'content', reason: 'calibration-active' },
  );
  assert.deepEqual(
    decideCalibrationStart({ ...READY, publisherControlConnected: false, micStreaming: false }),
    { ok: false, mode: 'content', reason: 'sources-not-connected' },
  );
  assert.deepEqual(
    decideCalibrationStart({ ...READY, backingStreaming: false }),
    { ok: false, mode: 'content', reason: 'sources-not-streaming' },
  );
});

test('Robot boot probe needs fresh capture paths, not a playing phone timeline', () => {
  assert.deepEqual(
    decideCalibrationStart({
      ...READY,
      robotProbeTimingActive: true,
      timelineConnected: true,
      timelineState: 2,
    }),
    { ok: true, mode: 'boot-probe' },
  );
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

test('Robot boot probe reports capture freshness failures without phone-not-playing', () => {
  const micStale = decideCalibrationStart({
    ...READY,
    robotProbeTimingActive: true,
    micStreaming: false,
    timelineConnected: false,
    timelineState: null,
  });
  assert.deepEqual(micStale, {
    ok: false,
    mode: 'boot-probe',
    reason: 'sources-not-streaming',
  });
  assert.notEqual(micStale.reason, 'phone-not-playing');

  const backingStale = decideCalibrationStart({
    ...READY,
    robotProbeTimingActive: true,
    backingStreaming: false,
    timelineConnected: false,
    timelineState: null,
  });
  assert.deepEqual(backingStale, {
    ok: false,
    mode: 'boot-probe',
    reason: 'sources-not-streaming',
  });
  assert.notEqual(backingStale.reason, 'phone-not-playing');
});

test('content calibration alone requires the phone timeline to be playing', () => {
  assert.deepEqual(
    decideCalibrationStart({ ...READY, timelineConnected: false, timelineState: null }),
    { ok: false, mode: 'content', reason: 'phone-not-playing' },
  );
  assert.deepEqual(
    decideCalibrationStart({ ...READY, timelineState: 2 }),
    { ok: false, mode: 'content', reason: 'phone-not-playing' },
  );
  assert.deepEqual(decideCalibrationStart(READY), { ok: true, mode: 'content' });
});
