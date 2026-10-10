import assert from 'node:assert/strict';
import test from 'node:test';
import { YouTubeTimelineTracker } from '../src/youtube-timeline.js';

const telemetry = (currentTime: number, playbackRate = 1) => ({
  videoId: 'dQw4w9WgXcQ', state: 1, duration: 1000,
  currentTime, playbackRate, networkRttMs: 24,
});
const status = (tracker: YouTubeTimelineTracker, now: number) =>
  tracker.statusPayload(now) as Record<string, any>;

test('slow or fast reported clocks cannot accumulate seconds of phase error', () => {
  for (const effectiveRate of [.9, 1.1]) {
    const tracker = new YouTubeTimelineTracker();
    tracker.update(telemetry(10), 0);
    for (let now = 250; now <= 120_000; now += 250) {
      tracker.update(telemetry(10 + now / 1000 * effectiveRate), now);
      assert.ok(Math.abs(status(tracker, now).differenceMs) < 550);
    }
    const s = status(tracker, 120_000);
    assert.ok(s.phaseCorrections > 10);
    assert.ok(Math.abs(s.driftMsPerMinute - (effectiveRate - 1) * 60_000) < 1);
  }
});

test('restoring equal speed also repairs the phase error accumulated beforehand', () => {
  const tracker = new YouTubeTimelineTracker();
  tracker.update(telemetry(10), 0);
  for (let now = 250; now <= 5000; now += 250) {
    tracker.update(telemetry(10 + now / 1000 * .9), now);
  }
  for (let now = 5250; now <= 15000; now += 250) {
    tracker.update(telemetry(14.5 + (now - 5000) / 1000), now);
  }
  assert.equal(status(tracker, 15000).phaseCorrections, 1);
  assert.ok(Math.abs(status(tracker, 15000).differenceMs) < 1);
});

test('a short telemetry bias and ordinary jitter do not redirect the room clock', () => {
  const tracker = new YouTubeTimelineTracker();
  tracker.update(telemetry(10), 0);
  for (let now = 250; now <= 10_000; now += 250) {
    const bias = now === 2000 || now === 2250 ? -.6 : Math.sin(now) * .02;
    tracker.update(telemetry(10 + now / 1000 + bias), now);
  }
  assert.equal(status(tracker, 10000).corrections, 0);
});

test('a frozen player loses authority without phase corrections hiding the stall', () => {
  const tracker = new YouTubeTimelineTracker();
  tracker.update(telemetry(10), 0);
  for (let now = 250; now <= 5000; now += 250) tracker.update(telemetry(10), now);
  assert.equal(status(tracker, 5000).phaseCorrections, 0);
  assert.equal(status(tracker, 5000).connected, false);
});

test('non-1x steady playback has no phase correction', () => {
  for (const rate of [.5, 2]) {
    const tracker = new YouTubeTimelineTracker();
    tracker.update(telemetry(10, rate), 0);
    for (let now = 250; now <= 10000; now += 250) {
      tracker.update(telemetry(10 + now / 1000 * rate, rate), now);
    }
    assert.equal(status(tracker, 10000).corrections, 0);
  }
});
