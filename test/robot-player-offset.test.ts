import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { RobotPlayerOffsetTracker } from '../src/robot-player-offset.js';
import {
  functionCode,
  parseTypeScriptSource,
  sourceCode,
  variableInitializerCode,
} from './support/source-contract.js';

const server = parseTypeScriptSource(
  new URL('../src/server.ts', import.meta.url),
  readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'),
);

function tracker() {
  return new RobotPlayerOffsetTracker({ freshForMs: 2_000, windowMs: 2_000 });
}

test('a single report is usable immediately', () => {
  const offset = tracker();
  assert.equal(offset.offsetMs(0), null);
  assert.equal(offset.isFresh(0), false);

  offset.record(-420, 0);
  assert.equal(offset.offsetMs(0), -420);
  assert.equal(offset.isFresh(0), true);
});

/**
 * The deployed robot reports a ~19 ms peak-to-peak spread while its real
 * playback position moves by well under 1 ms/s. Alignment must see the position,
 * not the spread: this is the measurement that used to re-anchor the microphone
 * timeline several times a minute for movement that never happened.
 */
test('reporting noise does not move the offset that drives alignment', () => {
  const offset = tracker();
  const measured = [-422.4, -421.9, -423.6, -420.6, -417.5, -420.3, -419.5, -418.0];
  measured.forEach((value, index) => offset.record(value, index * 250));

  const smoothed = offset.offsetMs(measured.length * 250)!;
  const rawSpread = Math.max(...measured) - Math.min(...measured);
  assert.ok(rawSpread > 6, `the sample under test must actually be noisy, got ${rawSpread}`);
  assert.ok(
    Math.abs(smoothed - -420.45) < 0.001,
    `expected the median of the window, got ${smoothed}`,
  );
});

test('a single wild reading cannot drag the offset with it', () => {
  const offset = tracker();
  [-420, -419, -421, -420, -418].forEach((value, index) => offset.record(value, index * 250));
  const before = offset.offsetMs(1_000)!;

  offset.record(-1_800, 1_250);
  const after = offset.offsetMs(1_250)!;
  assert.ok(Math.abs(after - before) < 2, `outlier moved the offset from ${before} to ${after}`);
});

test('drift that persists is followed rather than rejected', () => {
  const offset = tracker();
  for (let index = 0; index < 8; index += 1) offset.record(-420, index * 250);
  assert.equal(offset.offsetMs(1_750), -420);

  // A real seek settles on a new position and stays there.
  for (let index = 8; index < 16; index += 1) offset.record(-300, index * 250);
  assert.equal(offset.offsetMs(3_750), -300);
});

test('history outside the window is not answered from', () => {
  const offset = tracker();
  offset.record(-420, 0);
  assert.equal(offset.offsetMs(1_999), -420);
  assert.equal(offset.offsetMs(2_001), null);
});

/**
 * Freshness is authority, and authority belongs to arrival. A robot that stopped
 * reporting must lose it at the same instant it always did.
 */
test('a robot that goes quiet loses timing authority on schedule', () => {
  const offset = tracker();
  offset.record(-420, 0);
  assert.equal(offset.isFresh(2_000), true);
  assert.equal(offset.isFresh(2_001), false);
});

test('reset drops both the history and the freshness it granted', () => {
  const offset = tracker();
  offset.record(-420, 0);
  offset.reset();
  assert.equal(offset.offsetMs(0), null);
  assert.equal(offset.isFresh(0), false);
});

test('a report that is not a number is refused rather than stored', () => {
  const offset = tracker();
  offset.record(Number.NaN, 0);
  offset.record(Number.POSITIVE_INFINITY, 0);
  assert.equal(offset.offsetMs(0), null);
  assert.equal(offset.isFresh(0), false);
});

test('the server aligns against the tracker and only then requests a backing boundary', () => {
  assert.ok(variableInitializerCode(server, 'robotPlayerOffset').includes('new RobotPlayerOffsetTracker({'));

  const infrastructure = variableInitializerCode(server, 'infrastructureEventProtocol');
  const recorded = infrastructure.indexOf('robotPlayerOffset.record(offsetMs, nowMs)');
  const mapped = infrastructure.indexOf('robotContentTimeline.notePlayerOffset(');
  const requested = infrastructure.indexOf('if (mapped) requestRobotBackingBoundary(nowMs)');
  assert.ok(recorded >= 0, 'Robot offset reports must enter RobotPlayerOffsetTracker');
  assert.ok(mapped > recorded, 'timeline mapping must consume the tracked offset after it is recorded');
  assert.ok(requested > mapped, 'backing-boundary requests must follow accepted timeline mapping');
  assert.ok(infrastructure.includes('robotPlayerOffset.offsetMs(nowMs) ?? offsetMs'));

  const currentDelta = functionCode(server, 'currentDeltaMs');
  assert.ok(currentDelta.includes('robotDeltaIsFresh(nowMs) ? robotPlayerOffset.offsetMs(nowMs)! : 0'));

  // No raw last-value state may survive alongside it, or the two can disagree.
  // `robotPlayerOffsetMs:` remains as a published status field, so this pins the
  // absence of the mutable variables it used to be read from.
  const serverCode = sourceCode(server);
  assert.doesNotMatch(serverCode, /let robotPlayerOffset(Ms|At)\b/);
  assert.doesNotMatch(serverCode, /robotPlayerOffset(Ms|At) =/);
});
