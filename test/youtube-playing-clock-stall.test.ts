import assert from 'node:assert/strict';
import test from 'node:test';

import { YouTubeTimelineTracker } from '../src/youtube-timeline.js';

const VIDEO = 'dQw4w9WgXcQ';

function telemetry(overrides: Record<string, unknown> = {}) {
  return {
    videoId: VIDEO,
    state: 1,
    currentTime: 10,
    duration: 200,
    playbackRate: 1,
    bufferedFraction: 0.5,
    ...overrides,
  };
}

test('fresh 250 ms PLAYING telemetry cannot keep a frozen media clock authoritative', () => {
  const tracker = new YouTubeTimelineTracker();
  assert.equal(tracker.update(telemetry(), 0), true);

  for (let nowMs = 250; nowMs <= 2_000; nowMs += 250) {
    // This is the formal browser cadence. A frozen IFrame reports about -250 ms
    // of local timeline delta each sample, below the existing jump threshold.
    assert.equal(tracker.update(telemetry({ timelineDeltaSeconds: -0.25 }), nowMs), true);
  }

  const status = tracker.statusPayload(2_000) as Record<string, any>;
  assert.equal(status.telemetryAgeMs, 0, 'packets are still arriving on time');
  assert.equal(status.clockAgeMs, 2_000, 'clock age follows the last real PLAYING progress');
  assert.equal(status.ageMs, 2_000, 'compatibility age must describe clock authority');
  assert.equal(status.connected, false, 'fresh packets cannot keep a frozen media clock authoritative');
});

test('throttled frozen telemetry cannot renew clock progress through correction classification', () => {
  const tracker = new YouTubeTimelineTracker();
  assert.equal(tracker.update(telemetry(), 0), true);

  for (let nowMs = 1_000; nowMs <= 3_000; nowMs += 1_000) {
    // A background-throttled timer makes the same frozen position look like a
    // large jump. Correction bookkeeping may re-anchor it, but that is still
    // not evidence that getCurrentTime() actually moved.
    assert.equal(tracker.update(telemetry({ timelineDeltaSeconds: -1 }), nowMs), true);
  }

  const status = tracker.statusPayload(3_000) as Record<string, any>;
  assert.equal(status.telemetryAgeMs, 0);
  assert.equal(status.clockAgeMs, 3_000);
  assert.equal(status.connected, false);
  assert.ok(status.corrections > 0, 'the regression must exercise correction classification');
});

test('real 250 ms PLAYING progress keeps the media clock authoritative', () => {
  const tracker = new YouTubeTimelineTracker();
  assert.equal(tracker.update(telemetry(), 0), true);

  for (let nowMs = 250; nowMs <= 5_000; nowMs += 250) {
    assert.equal(tracker.update(telemetry({ currentTime: 10 + nowMs / 1_000 }), nowMs), true);
  }

  const status = tracker.statusPayload(5_000) as Record<string, any>;
  assert.equal(status.telemetryAgeMs, 0);
  assert.equal(status.clockAgeMs, 0);
  assert.equal(status.connected, true);
});

test('PAUSED telemetry stays authoritative without requiring position progress', () => {
  const tracker = new YouTubeTimelineTracker();
  assert.equal(tracker.update(telemetry({ state: 2 }), 0), true);

  for (let nowMs = 250; nowMs <= 5_000; nowMs += 250) {
    assert.equal(tracker.update(telemetry({ state: 2 }), nowMs), true);
  }

  const status = tracker.statusPayload(5_000) as Record<string, any>;
  assert.equal(status.telemetryAgeMs, 0);
  assert.equal(status.clockAgeMs, 0);
  assert.equal(status.ageMs, 0);
  assert.equal(status.connected, true, 'a paused clock is healthy while its telemetry remains fresh');
});
