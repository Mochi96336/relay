import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { RobotContentTimelineMapper } from '../src/robot-content-timeline.js';
import type { CalibrationContext } from '../src/calibration-session.js';

const RATE = 48_000;
const context: CalibrationContext = {
  sessionGeneration: 1,
  micGeneration: 2,
  backingGeneration: 3,
  sourceGeneration: 4,
};

describe('RobotContentTimelineMapper', () => {
  test('holds live authority on pre-seek content until PCM commits the new boundary', () => {
    const mapper = new RobotContentTimelineMapper({ sampleRate: RATE, freshForMs: 2_000 });
    mapper.notePlayerOffset(500, context, 0);

    assert.equal(mapper.mapBackingStart(RATE * 4, context, 10), RATE * 4);
    assert.equal(mapper.liveLagMs(750, context, 10), 750);
    assert.equal(mapper.currentDeltaMs, 500);
    assert.equal(mapper.committedDeltaMs, 500);

    assert.equal(mapper.noteFollowerCorrection(100.5, 100, context, 700), true);
    assert.equal(mapper.needsBackingBoundary(context), true);
    assert.equal(mapper.currentDeltaMs, 0, 'control plane observes the seek immediately');
    assert.equal(mapper.committedDeltaMs, 500, 'backing content remains on the pre-seek mapping');
    assert.equal(
      mapper.mapBackingStart(RATE * 5, context, 700),
      null,
      'cross-socket arrival order cannot decide which PCM side owns the seek',
    );
    assert.equal(
      mapper.liveLagMs(750, context, 700),
      750,
      'queued pre-seek backing must keep the pre-seek live alignment',
    );

    mapper.notePlayerOffset(0, context, 705);
    assert.equal(mapper.currentDeltaMs, 0);
    assert.equal(
      mapper.committedDeltaMs,
      500,
      'fresh player telemetry is still pending until backing PCM proves the new content',
    );

    const boundary = RATE * 5;
    assert.equal(mapper.noteBackingBoundary(boundary, context, 710), true);
    assert.equal(mapper.needsBackingBoundary(context), false);
    assert.equal(mapper.committedDeltaMs, 0);
    assert.equal(mapper.liveLagMs(750, context, 710), 250);
    assert.equal(mapper.mapBackingStart(boundary - 1, context, 710), null);
    assert.equal(
      mapper.mapBackingStart(boundary, context, 710),
      boundary - RATE / 2,
      'only samples at or after the content-proven frontier use the new segment',
    );
  });

  test('applies the concrete seek jump without erasing a smoothed residual', () => {
    const mapper = new RobotContentTimelineMapper({ sampleRate: RATE, freshForMs: 2_000 });
    mapper.notePlayerOffset(500, context, 0);
    mapper.notePlayerOffset(480, context, 100);

    assert.equal(mapper.noteFollowerCorrection(100.5, 100, context, 200), true);
    assert.equal(
      mapper.currentDeltaMs,
      -20,
      'a 500 ms backward media jump applied to a smoothed +480 ms delta leaves the real -20 ms residual',
    );
    assert.equal(mapper.committedDeltaMs, 480);
    assert.equal(
      mapper.liveLagMs(750, context, 200),
      730,
      'the live mixer keeps the previously committed residual until new content reaches PCM',
    );
    assert.equal(mapper.mapBackingStart(RATE * 5, context, 200), null);
    assert.equal(mapper.noteBackingBoundary(RATE * 5, context, 210), true);
    assert.equal(mapper.committedDeltaMs, -20);
    assert.equal(
      mapper.mapBackingStart(RATE * 5, context, 210),
      RATE * 5 - Math.round(RATE * 0.52),
      'backing mapping must include both the concrete seek jump and the pre-existing residual',
    );
    assert.equal(
      mapper.liveLagMs(750, context, 210),
      230,
      'reference alignment must retain the residual instead of forcing the post-seek player delta to zero',
    );
  });

  test('ordinary player-offset updates still move committed content when no seek is pending', () => {
    const mapper = new RobotContentTimelineMapper({ sampleRate: RATE, freshForMs: 2_000 });
    mapper.notePlayerOffset(500, context, 0);
    mapper.notePlayerOffset(460, context, 100);

    assert.equal(mapper.currentDeltaMs, 460);
    assert.equal(mapper.committedDeltaMs, 460);
    assert.equal(mapper.liveLagMs(750, context, 100), 710);
  });

  test('requires concrete mapping evidence and the same calibration context', () => {
    const mapper = new RobotContentTimelineMapper({ sampleRate: RATE, freshForMs: 2_000 });
    assert.equal(mapper.noteFollowerCorrection(100.5, 100, context, 0), false);
    mapper.notePlayerOffset(500, context, 10);

    const changed = { ...context, backingGeneration: 9 };
    assert.equal(mapper.mapBackingStart(0, changed, 20), null);
    assert.equal(mapper.noteFollowerCorrection(100.5, 100, changed, 20), false);
    assert.equal(mapper.noteBackingBoundary(0, changed, 20), false);
  });

  test('a backing boundary never refreshes stale player authority', () => {
    const mapper = new RobotContentTimelineMapper({ sampleRate: RATE, freshForMs: 1_000 });
    mapper.notePlayerOffset(120, context, 100);
    assert.equal(mapper.noteFollowerCorrection(10.5, 10, context, 200), true);
    assert.equal(mapper.noteBackingBoundary(RATE, context, 1_100), true);
    assert.equal(mapper.isReady(context, 1_200), true);
    assert.equal(mapper.isReady(context, 1_201), false);
    assert.equal(mapper.liveLagMs(400, context, 1_201), null);
  });
});
