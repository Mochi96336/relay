import assert from 'node:assert/strict';
import test from 'node:test';

import { YouTubeTimelineTracker } from '../src/youtube-timeline.js';

function telemetry(overrides: Record<string, unknown> = {}) {
  return {
    videoId: 'dQw4w9WgXcQ',
    state: 1,
    currentTime: 10,
    duration: 200,
    playbackRate: 1,
    bufferedFraction: 0.5,
    ...overrides,
  };
}

test('YouTube timeline exposes descriptive title and author without affecting timing', () => {
  const tracker = new YouTubeTimelineTracker();
  assert.equal(tracker.update(telemetry({
    videoTitle: '  林俊傑   JJ Lin - 偉大的渺小  ',
    videoAuthor: '  JJ Lin 林俊傑  ',
  }), 0), true);

  const status = tracker.statusPayload(100) as Record<string, unknown>;
  assert.equal(status.videoTitle, '林俊傑 JJ Lin - 偉大的渺小');
  assert.equal(status.videoAuthor, 'JJ Lin 林俊傑');
  assert.equal(status.videoId, 'dQw4w9WgXcQ');
});

test('same-video telemetry may omit metadata without making the observer title flicker', () => {
  const tracker = new YouTubeTimelineTracker();
  tracker.update(telemetry({ videoTitle: 'Song A', videoAuthor: 'Singer A' }), 0);
  tracker.update(telemetry({ currentTime: 10.25 }), 250);

  const status = tracker.statusPayload(300) as Record<string, unknown>;
  assert.equal(status.videoTitle, 'Song A');
  assert.equal(status.videoAuthor, 'Singer A');
});

test('a new video cannot inherit the previous song metadata', () => {
  const tracker = new YouTubeTimelineTracker();
  tracker.update(telemetry({ videoTitle: 'Song A', videoAuthor: 'Singer A' }), 0);
  tracker.update(telemetry({
    videoId: 'abcdefghijk',
    currentTime: 0,
  }), 250);

  const status = tracker.statusPayload(300) as Record<string, unknown>;
  assert.equal(status.videoId, 'abcdefghijk');
  assert.equal(status.videoTitle, null);
  assert.equal(status.videoAuthor, null);
});
