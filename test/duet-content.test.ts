import assert from 'node:assert/strict';
import test from 'node:test';

import { DuetContent, DUET_CONTENT_WINDOW_SECONDS, type DuetContentAnalyzer } from '../src/duet-content.js';
import { analyzeTimingCalibration } from '../src/timing-calibration.js';
import { laggedMultibandMusicPair } from './helpers/music-calibration.js';

const RATE = 48_000;
const SAMPLES = DUET_CONTENT_WINDOW_SECONDS * RATE;

/**
 * One backing, and two singers placed on the session timeline `shiftAMs` and
 * `shiftBMs` after it: the same voice + bleed, at two different positions.
 */
function room(shiftAMs: number, shiftBMs: number) {
  const pair = laggedMultibandMusicPair(DUET_CONTENT_WINDOW_SECONDS + 1, RATE, 0, { singerGain: 0.18 });
  // The helper returns PCM16 bytes.
  const samples = (bytes: Buffer) => new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2).slice();
  return {
    mic: samples(pair.mic), backing: samples(pair.backing),
    shiftA: Math.round((shiftAMs * RATE) / 1000),
    shiftB: Math.round((shiftBMs * RATE) / 1000),
  };
}

const realAnalyzer: DuetContentAnalyzer = async (mic, backing) => {
  const result = analyzeTimingCalibration(mic, backing, RATE);
  return { micLagMs: result.micLagMs, confidence: result.confidence };
};

function feed(content: DuetContent, input: ReturnType<typeof room>, { b = true, backingHole = false } = {}) {
  for (let start = 0; start + 960 <= input.backing.length; start += 960) {
    const inHole = backingHole && start >= 2 * RATE && start < 3 * RATE;
    if (!inHole) content.observeBacking(input.backing.subarray(start, start + 960), start);
    content.observePrimary(input.mic.subarray(start, start + 960), start + input.shiftA);
    if (b) content.observeSecondary(input.mic.subarray(start, start + 960), start + input.shiftB);
  }
}

async function settle(content: DuetContent, ticks = 4) {
  for (let i = 0; i < ticks; i++) {
    content.tick(i * 10_000);
    for (let n = 0; n < 4; n++) await Promise.resolve();
  }
}

test("B is placed by its lag relative to A, both against the same backing", async () => {
  const content = new DuetContent({ sampleRate: RATE, minConfidence: 0.1, analyze: realAnalyzer });
  feed(content, room(40, 160));
  await settle(content);
  const offset = content.secondaryOffsetMs;
  assert.notEqual(offset, null, JSON.stringify(content.status()));
  // B sits 120 ms later on the timeline than A, against the one backing.
  assert.ok(Math.abs(Math.abs(offset!) - 120) < 3, `offset ${offset}`);
});

test('no offset until both singers are measured', async () => {
  const content = new DuetContent({ sampleRate: RATE, minConfidence: 0.1, analyze: realAnalyzer });
  feed(content, room(40, 160), { b: false });
  await settle(content);
  assert.notEqual(content.status().primaryLagMs, null);
  assert.equal(content.secondaryOffsetMs, null);
});

test('a reset retires both measurements and any analysis still running', async () => {
  let release!: (value: { micLagMs: number; confidence: number }) => void;
  const pending: DuetContentAnalyzer = () => new Promise((resolve) => { release = resolve; });
  const content = new DuetContent({ sampleRate: RATE, minConfidence: 0.1, analyze: pending });
  feed(content, room(0, 0));
  assert.equal(content.tick(0), true);
  content.reset('seek');
  release({ micLagMs: 10, confidence: 0.9 });
  await Promise.resolve();
  assert.equal(content.status().primaryLagMs, null);
  assert.equal(content.status().lastResetReason, 'seek');
});

test('low confidence and gappy windows are rejected with a backoff', async () => {
  const weak: DuetContentAnalyzer = async () => ({ micLagMs: 10, confidence: 0.05 });
  const content = new DuetContent({ sampleRate: RATE, minConfidence: 0.2, analyze: weak });
  feed(content, room(0, 0));
  content.tick(0);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(content.status().lastFailureReason, 'low-confidence');
  assert.equal(content.tick(100), false, 'backs off after a failure');

  const gappy = new DuetContent({ sampleRate: RATE, minConfidence: 0.2, analyze: weak });
  // Backing with a one-second hole in the middle.
  feed(gappy, room(0, 0), { b: false, backingHole: true });
  gappy.tick(0);
  assert.equal(gappy.status().lastFailureReason, 'window-gaps');
  assert.equal(gappy.stats.submitted, 0);
});

test('a pause or seek keeps placing B by the last difference; a capture restart does not', async () => {
  // Singers alternate, A first: A measures 30 ms, B 90 ms.
  const answers = [30, 90];
  const content = new DuetContent({
    sampleRate: RATE, minConfidence: 0.1,
    analyze: async () => ({ micLagMs: answers.shift()!, confidence: 0.9 }),
  });
  feed(content, room(0, 0));
  await settle(content);
  assert.equal(content.secondaryOffsetMs, 60);

  content.reset('song');
  assert.equal(content.secondaryOffsetMs, 60, 'held until re-measured');
  assert.equal(content.status().heldOffsetMs, 60);
  content.reset('b-capture-restarted', { hard: true });
  assert.equal(content.secondaryOffsetMs, null);
});
