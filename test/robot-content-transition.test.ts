import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  compareRobotContentHypotheses,
  estimateRobotContentRawLag,
} from '../src/robot-content-transition.js';
import { pulseTrain } from './helpers/harness.js';

const RATE = 48_000;
const PRE_LAG_MS = 750;
const POST_LAG_MS = 250;

function shifted(master: Float64Array, start: number, count: number, lagMs: number, gain: number) {
  const shift = Math.round((RATE * lagMs) / 1_000);
  const result = new Int16Array(count);
  for (let index = 0; index < count; index += 1) {
    const value = master[start + shift + index] * gain;
    result[index] = Math.round(Math.max(-1, Math.min(1, value)) * 32767);
  }
  return result;
}

test('short stable pre-seek history anchors the raw lag without becoming authority', () => {
  const count = RATE * 3;
  const master = pulseTrain(count + RATE * 2, RATE, 17);
  const mic = shifted(master, 0, count, 0, 0.45);
  const backing = shifted(master, 0, count, PRE_LAG_MS, 0.9);

  const result = estimateRobotContentRawLag(mic, backing, RATE, 1_500);
  assert.ok(result, 'stable music should provide a transition-only raw-lag anchor');
  assert.ok(
    Math.abs(result.rawLagMs - PRE_LAG_MS) <= 20,
    `expected about ${PRE_LAG_MS} ms, got ${result.rawLagMs}`,
  );
  assert.ok(result.supportingBands >= 3);
});

test('queued pre-seek PCM wins the old hypothesis after a transport cursor ACK', () => {
  const count = Math.round(RATE * 0.65);
  const start = RATE * 4;
  const master = pulseTrain(start + count + RATE * 2, RATE, 29);
  const backing = shifted(master, start, count, PRE_LAG_MS, 0.9);
  const preMic = shifted(master, start, count, PRE_LAG_MS, 0.45);
  const postMic = shifted(master, start, count, POST_LAG_MS, 0.45);

  const result = compareRobotContentHypotheses(backing, preMic, postMic, RATE);
  assert.equal(result.verdict, 'pre');
  assert.ok((result.preScore ?? -1) > (result.postScore ?? -1));
});

test('real post-seek PCM wins only the new raw-lag hypothesis', () => {
  const count = Math.round(RATE * 0.65);
  const start = RATE * 4;
  const master = pulseTrain(start + count + RATE * 2, RATE, 31);
  const backing = shifted(master, start, count, POST_LAG_MS, 0.9);
  const preMic = shifted(master, start, count, PRE_LAG_MS, 0.45);
  const postMic = shifted(master, start, count, POST_LAG_MS, 0.45);

  const result = compareRobotContentHypotheses(backing, preMic, postMic, RATE);
  assert.equal(result.verdict, 'post');
  assert.ok((result.postScore ?? -1) > (result.preScore ?? -1));
});

test('silent evidence cannot commit a media segment', () => {
  const count = Math.round(RATE * 0.65);
  const silence = new Int16Array(count);
  const result = compareRobotContentHypotheses(silence, silence, silence, RATE);
  assert.equal(result.verdict, 'ambiguous');
});
