import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { RobotOffsetDelay } from '../src/robot-offset-delay.js';

test('the delay is how far the target moved between the Robot using it and its report arriving', () => {
  const delay = new RobotOffsetDelay(30_000);
  // The Robot measured against 12.000 s; when its report arrives the target stands at 12.018 s.
  assert.equal(delay.note(12, 12.018, 1, 1_000), null);
  assert.ok(Math.abs(delay.lastMs! - 18) < 1e-6);
  // At 2x the same 18 ms of media is 9 ms of real time.
  delay.note(20, 20.018, 2, 1_250);
  assert.ok(Math.abs(delay.lastMs! - 9) < 1e-6);
});

test('a seek, a pause or a new song between the two readings is not a delay', () => {
  const delay = new RobotOffsetDelay(30_000);
  for (const [reported, current, rate] of [[12, 11.9, 1], [12, 14, 1], [Number.NaN, 12, 1], [12, 12.01, 0], [12, Number.POSITIVE_INFINITY, 1]]) {
    assert.equal(delay.note(reported, current, rate, 1_000), null);
    assert.equal(delay.lastMs, null, `${reported} -> ${current} at ${rate}x`);
  }
});

test('one summary per interval, then a fresh window', () => {
  const delay = new RobotOffsetDelay(30_000);
  let summary = null;
  // Four reports a second: mostly 4 ms, every tenth 40 ms, one 120 ms.
  for (let i = 0; i <= 120; i += 1) {
    const ms = i === 57 ? 120 : i % 10 === 9 ? 40 : 4;
    summary = delay.note(100 + i / 4, 100 + i / 4 + ms / 1000, 1, i * 250);
    if (i < 120) assert.equal(summary, null, `report ${i}`);
  }
  assert.deepEqual(summary, { samples: 121, medianMs: 4, p90Ms: 40, maxMs: 120 });
  assert.equal(delay.note(200, 200.004, 1, 30_250), null, 'the next window starts empty');
});

test('the server measures on each Robot offset report while the song plays, and changes no offset', () => {
  const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  assert.match(server, /const delaySummary = timelineNow\.state === 1 \? robotOffsetDelay\.note\( Number\(diagnostic\?\.targetSeconds\), Number\(timelineNow\.youtubeTime \?\? timelineNow\.serverTime\), currentPlaybackRate\(nowMs\), nowMs, \) : null;/);
  assert.match(server, /if \(delaySummary\) console\.warn\('\[robot-offset-delay\]', JSON\.stringify\(delaySummary\)\);/);
  // The offset that feeds calibration is recorded exactly as reported.
  assert.match(server, /if \(!robotPlayerOffset\.record\(offsetMs, nowMs\)\) return;/);
});
