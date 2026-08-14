import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

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

describe('YouTubeTimelineTracker', () => {
  test('ignores telemetry without a valid video id', () => {
    const tracker = new YouTubeTimelineTracker();
    assert.equal(tracker.update(telemetry({ videoId: 'nope' }), 0), false);
    assert.equal(tracker.update(telemetry({ videoId: '' }), 0), false);
    assert.equal(tracker.hasTelemetry, false);
  });

  test('ignores a negative or non-finite media time', () => {
    const tracker = new YouTubeTimelineTracker();
    assert.equal(tracker.update(telemetry({ currentTime: -1 }), 0), false);
    assert.equal(tracker.update(telemetry({ currentTime: 'x' }), 0), false);
  });

  test('reports disconnected until the first sample', () => {
    const tracker = new YouTubeTimelineTracker();
    assert.deepEqual(tracker.statusPayload(0), {
      type: 'youtube-timeline-status',
      connected: false,
    });
  });

  test('projects the media clock forward while playing', () => {
    const tracker = new YouTubeTimelineTracker();
    tracker.update(telemetry({ currentTime: 10 }), 0);

    const status = tracker.statusPayload(2_000) as Record<string, any>;
    assert.equal(status.connected, false, 'a two-second-old sample is stale');
    assert.ok(Math.abs(status.serverTime - 12) < 0.05, `serverTime ${status.serverTime}`);
  });

  test('holds the clock still while paused', () => {
    const tracker = new YouTubeTimelineTracker();
    tracker.update(telemetry({ state: 2, currentTime: 30 }), 0);

    const status = tracker.statusPayload(1_000) as Record<string, any>;
    assert.equal(status.serverTime, 30);
  });

  test('honours the playback rate', () => {
    const tracker = new YouTubeTimelineTracker();
    tracker.update(telemetry({ currentTime: 10, playbackRate: 2 }), 0);

    const status = tracker.statusPayload(1_000) as Record<string, any>;
    assert.ok(Math.abs(status.serverTime - 12) < 0.05, `serverTime ${status.serverTime}`);
  });

  test('counts steady playback as neither a re-anchor nor a correction', () => {
    const tracker = new YouTubeTimelineTracker();
    tracker.update(telemetry({ currentTime: 10 }), 0);
    for (let i = 1; i <= 4; i += 1) {
      tracker.update(telemetry({ currentTime: 10 + i * 0.25 }), i * 250);
    }

    const status = tracker.statusPayload(1_000) as Record<string, any>;
    assert.equal(status.reanchors, 0);
    assert.equal(status.corrections, 0);
    assert.equal(status.lastReason, 'tracking');
  });

  test('classifies a seek as a correction, not a re-anchor', () => {
    const tracker = new YouTubeTimelineTracker();
    tracker.update(telemetry({ currentTime: 10 }), 0);
    tracker.update(telemetry({ currentTime: 10.25 }), 250);
    tracker.update(telemetry({ currentTime: 90 }), 500);

    const status = tracker.statusPayload(600) as Record<string, any>;
    assert.equal(status.corrections, 1);
    assert.equal(status.reanchors, 0);
    assert.equal(status.lastReason, 'seek/jump');
  });

  test('classifies a state change as a re-anchor', () => {
    const tracker = new YouTubeTimelineTracker();
    tracker.update(telemetry({ currentTime: 10 }), 0);
    tracker.update(telemetry({ currentTime: 10.25, state: 2 }), 250);

    const status = tracker.statusPayload(300) as Record<string, any>;
    assert.equal(status.reanchors, 1);
    assert.equal(status.corrections, 0);
    assert.equal(status.lastReason, 'state');
  });

  test('treats a new video as a re-anchor and adopts its id', () => {
    const tracker = new YouTubeTimelineTracker();
    tracker.update(telemetry({ currentTime: 10 }), 0);
    tracker.update(telemetry({ videoId: 'abcdefghijk', currentTime: 0 }), 250);

    const status = tracker.statusPayload(300) as Record<string, any>;
    assert.equal(status.videoId, 'abcdefghijk');
    assert.equal(status.reanchors, 1);
    assert.equal(status.lastReason, 'video');
  });

  test('survives a seek that passes through buffering', () => {
    const tracker = new YouTubeTimelineTracker();
    tracker.update(telemetry({ currentTime: 10 }), 0);
    tracker.update(telemetry({ currentTime: 10.25, state: 3 }), 250);
    tracker.update(telemetry({ currentTime: 120, state: 1 }), 500);

    const status = tracker.statusPayload(600) as Record<string, any>;
    assert.equal(status.corrections, 1, 'the jump across buffering must count as a seek');
  });

  test('goes stale when telemetry stops', () => {
    const tracker = new YouTubeTimelineTracker();
    tracker.update(telemetry(), 0);
    assert.equal((tracker.statusPayload(500) as Record<string, any>).connected, true);
    assert.equal((tracker.statusPayload(5_000) as Record<string, any>).connected, false);
  });

  test('derives a one-way transport estimate from RTT', () => {
    const tracker = new YouTubeTimelineTracker();
    tracker.update(telemetry({ networkRttMs: 120 }), 1_000);

    const status = tracker.statusPayload(1_000) as Record<string, any>;
    assert.equal(status.networkRttMs, 120);
    assert.ok(Math.abs(status.transportEstimateMs - 60) < 1, `transport ${status.transportEstimateMs}`);
  });

  test('clamps an implausible playback rate', () => {
    const tracker = new YouTubeTimelineTracker();
    tracker.update(telemetry({ playbackRate: 99 }), 0);
    assert.equal((tracker.statusPayload(0) as Record<string, any>).playbackRate, 4);
  });
});
