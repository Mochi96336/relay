import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decideCalibrationStart,
  type CalibrationStartFacts,
} from '../src/calibration-start-policy.js';

const READY: CalibrationStartFacts = {
  takeLifecycle: 'idle',
  bootProbeCalibrationActive: false,
  sessionActive: true,
  backingConnected: true,
  publisherControlConnected: true,
  backingStreaming: true,
  micStreaming: true,
  robotProbeTimingActive: false,
  contentEvidenceReady: true,
  timelineConnected: true,
  timelineState: 1,
};

test('calibration start policy preserves runtime rejection precedence and mode', () => {
  assert.deepEqual(
    decideCalibrationStart({
      ...READY,
      takeLifecycle: 'recording',
      bootProbeCalibrationActive: true,
      sessionActive: false,
    }),
    { ok: false, mode: 'content', reason: 'take-active' },
  );
  assert.deepEqual(
    decideCalibrationStart({ ...READY, bootProbeCalibrationActive: true, sessionActive: false }),
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

test('content calibration waits for an evidence-usable Robot mapping without blocking boot probe', () => {
  assert.deepEqual(
    decideCalibrationStart({ ...READY, contentEvidenceReady: false }),
    { ok: false, mode: 'content', reason: 'content-mapping-pending' },
  );
  assert.deepEqual(
    decideCalibrationStart({
      ...READY,
      robotProbeTimingActive: true,
      contentEvidenceReady: false,
      timelineConnected: false,
      timelineState: null,
    }),
    { ok: true, mode: 'boot-probe' },
  );
});
/**
 * The same distinction the Take policy already draws.
 *
 * The boot probe plays its own chimes and needs both captures to itself, so a
 * second run really would collide with it. Content calibration only listens to
 * audio the room is already making - it holds nothing up and the singer cannot
 * perceive it. Refusing a deliberate Realign because of one describes a
 * measurement rather than the room, and leaves the action unavailable for most
 * of a session whenever automatic content runs are retrying.
 */
test('a background content run does not refuse a deliberate Realign', () => {
  assert.deepEqual(
    decideCalibrationStart({ ...READY, bootProbeCalibrationActive: false }),
    { ok: true, mode: 'content' },
  );
  assert.deepEqual(
    decideCalibrationStart({
      ...READY,
      robotProbeTimingActive: true,
      bootProbeCalibrationActive: false,
    }),
    { ok: true, mode: 'boot-probe' },
  );
});

test('the audible boot probe still refuses a second run', () => {
  assert.deepEqual(
    decideCalibrationStart({ ...READY, bootProbeCalibrationActive: true }),
    { ok: false, mode: 'content', reason: 'calibration-active' },
  );
});

/**
 * A Robot route has no Desktop Source for anyone to connect: the second leg is
 * this machine's own browser. Sharing `sources-not-connected` with the case
 * where the user really has a transport missing produced a recovery
 * instruction pointing at something that does not exist on the deployment.
 */
test('a missing Robot leg is not the user failing to connect a device', () => {
  assert.deepEqual(
    decideCalibrationStart({
      ...READY,
      robotProbeTimingActive: true,
      backingIsRobot: false,
    }),
    { ok: false, mode: 'boot-probe', reason: 'robot-route-incomplete' },
  );
  assert.deepEqual(
    decideCalibrationStart({
      ...READY,
      robotProbeTimingActive: true,
      robotSourceConnected: false,
    }),
    { ok: false, mode: 'boot-probe', reason: 'robot-route-incomplete' },
  );

  // A transport the user actually owns keeps the reason that names it.
  assert.deepEqual(
    decideCalibrationStart({
      ...READY,
      robotProbeTimingActive: true,
      publisherControlConnected: false,
    }),
    { ok: false, mode: 'boot-probe', reason: 'sources-not-connected' },
  );
});
