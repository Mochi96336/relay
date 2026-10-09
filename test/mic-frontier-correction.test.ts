import assert from 'node:assert/strict';
import test from 'node:test';

import { MicClockTrim } from '../src/mic-clock-trim.js';
import { MicFrontierCorrection, type MicFrontierFrame } from '../src/mic-frontier-correction.js';

const RATE = 48_000;
const FRAME = 960;
const LOOKAHEAD = 144;
const SPAN = FRAME + LOOKAHEAD;
const MARGIN = 9_600; // the 200 ms safety margin
const CAP = 6_576 + 134_400;

function correction() {
  return new MicFrontierCorrection({
    sampleRate: RATE,
    frameMs: 20,
    frameSamples: FRAME,
    lookaheadSamples: LOOKAHEAD,
    safetyMs: 200,
    slewFraction: 0.01,
  });
}

/**
 * A frame reading `advance` samples ahead of `startSample` against a frontier
 * `slack` samples past the end of its read window (negative: overrun).
 */
function frame(
  subject: MicFrontierCorrection,
  startSample: number,
  slack: number,
  overrides: Partial<MicFrontierFrame> = {},
): MicFrontierFrame {
  const advance = 6_576 - subject.correctionSamples;
  return {
    expected: true,
    frontier: startSample + advance + SPAN + slack,
    earliestRetained: 0,
    startSample,
    appliedAdvanceSamples: advance,
    capSamples: CAP,
    ...overrides,
  };
}

test('a stream that is suddenly late is held back in one step, with the safety margin', () => {
  const subject = correction();
  let start = 100_000;
  for (let index = 0; index < 60; index += 1, start += FRAME) subject.update(frame(subject, start, 4_800));
  assert.equal(subject.correctionSamples, 0);

  // 400 ms later than the read window allows.
  subject.update(frame(subject, start, -19_200));
  assert.equal(subject.correctionSamples, 19_200 + MARGIN);
});

test('a frontier that has stopped is starvation, not lateness to chase', () => {
  const subject = correction();
  let start = 100_000;
  // The live mixer keeps about 240 ms of slack, more than the stall threshold.
  const frozen = start + 6_576 + SPAN + 12_000;
  for (let index = 0; index < 60; index += 1, start += FRAME) {
    subject.update({ ...frame(subject, start, 0), frontier: frozen });
  }
  assert.equal(subject.correctionSamples, 0);
});

test('an outage while the Mic is not expected still counts as an outage when it is again', () => {
  const subject = correction();
  let start = 100_000;
  for (let index = 0; index < 20; index += 1, start += FRAME) subject.update(frame(subject, start, 4_800));
  const frozen = start + 6_576 + SPAN + 4_800;
  // The socket drops: not expected, nothing arrives for 1.5 s.
  for (let index = 0; index < 75; index += 1, start += FRAME) {
    subject.update({ ...frame(subject, start, 0), frontier: frozen, expected: false });
  }
  // Registered again; its first packet is still a round trip away.
  for (let index = 0; index < 8; index += 1, start += FRAME) {
    subject.update({ ...frame(subject, start, 0), frontier: frozen });
  }
  assert.equal(subject.correctionSamples, 0);
});

test('the correction is given back at the bounded rate once there is slack again', () => {
  const subject = correction();
  let start = 100_000;
  for (let index = 0; index < 60; index += 1, start += FRAME) subject.update(frame(subject, start, 4_800));
  subject.update(frame(subject, start, -19_200));
  const held = subject.correctionSamples;
  start += FRAME;
  // Delayed audio catches up: more than the margin of slack.
  subject.update(frame(subject, start, MARGIN + 1));
  assert.equal(subject.correctionSamples, held - 10); // 1% of a 20 ms frame
});

test('slack well past the margin is delayed audio that caught up, and is given back at once', () => {
  const subject = correction();
  let start = 100_000;
  for (let index = 0; index < 60; index += 1, start += FRAME) subject.update(frame(subject, start, 4_800));
  subject.update(frame(subject, start, -19_200));
  start += FRAME;
  // 150 ms of slack past the margin: holding on would keep the voice that late.
  subject.update(frame(subject, start, MARGIN + 7_200));
  assert.equal(subject.correctionSamples, 19_200 + MARGIN - 7_200);
});

test('audio still in transit is not held back for, but lateness from before it is kept', () => {
  const subject = correction();
  let start = 100_000;
  for (let index = 0; index < 60; index += 1, start += FRAME) subject.update(frame(subject, start, 4_800));
  // A capture that is steadily 400 ms late, with nothing in transit.
  subject.update(frame(subject, start, -19_200));
  start += FRAME;
  const steady = subject.correctionSamples;
  subject.noteTransit(40);

  // The uplink starts queueing: the frontier falls a further second behind
  // before a report says how much is in transit.
  for (let index = 0; index < 60; index += 1, start += FRAME) {
    subject.update(frame(subject, start, index === 0 ? -48_000 : 0));
  }
  assert.ok(subject.correctionSamples > steady, 'without evidence the read head is held back as before');

  subject.noteTransit(1_000);
  assert.equal(subject.correctionSamples, steady, 'only the lateness from before the queueing is kept');
  for (let index = 0; index < 60; index += 1, start += FRAME) {
    subject.update(frame(subject, start, -24_000));
  }
  assert.equal(subject.correctionSamples, steady, 'audio in transit is not waited for');

  // The queue drains and live audio arrives: ordinary correction again.
  subject.noteTransit(100);
  subject.update(frame(subject, start, -4_800));
  assert.equal(subject.correctionSamples, steady + 4_800 + MARGIN);
});

test('a report below the start of a transit episode does not start one', () => {
  const subject = correction();
  let start = 100_000;
  for (let index = 0; index < 60; index += 1, start += FRAME) subject.update(frame(subject, start, 4_800));
  subject.noteTransit(300);
  subject.update(frame(subject, start, -19_200));
  assert.equal(subject.correctionSamples, 19_200 + MARGIN);
});

test('confirmed capture loss is due to fold only for its own capture, near the bound', () => {
  const subject = correction();
  let start = 100_000;
  for (let index = 0; index < 60; index += 1, start += FRAME) subject.update(frame(subject, start, 4_800));
  subject.update({ ...frame(subject, start, -100_000) });
  const held = subject.correctionSamples;
  assert.ok(CAP - held <= RATE, 'within a second of the bound');

  subject.noteCaptureLoss(7, 200);
  assert.equal(subject.foldDue(true, 7, CAP), 0, 'below the 250 ms noise floor');
  subject.noteCaptureLoss(7, 500);
  assert.equal(subject.foldDue(true, 8, CAP), 0, 'another capture');
  assert.equal(subject.foldDue(false, 7, CAP), 0, 'a Mic nobody expects');
  assert.equal(subject.foldDue(true, 7, CAP), 24_000);

  subject.rebase(24_000);
  subject.folded(24_000, held);
  assert.equal(subject.correctionSamples, held - 24_000);
  assert.equal(subject.foldDue(true, 7, CAP), 0, 'room again after the fold');
  assert.deepEqual(subject.lastFold, {
    shiftMs: 500,
    correctionBeforeMs: Math.round((held / RATE) * 1000),
    captureLossMs: 500,
  });
  assert.equal(subject.foldCount, 1);
});

test('a fresh anchor has already absorbed the loss it was told about', () => {
  const subject = correction();
  subject.noteCaptureLoss(7, 500);
  subject.reset(7);
  let start = 100_000;
  for (let index = 0; index < 60; index += 1, start += FRAME) subject.update(frame(subject, start, 4_800));
  subject.update({ ...frame(subject, start, -100_000) });
  assert.equal(subject.foldDue(true, 7, CAP), 0);
});

test('clock trim leaves good clocks alone, clamps absurd ones and owes by the sample', () => {
  const trim = new MicClockTrim(RATE);
  trim.setPpm(10);
  assert.equal(trim.ppm, 0, 'inside the estimator error');
  trim.setPpm(9_000);
  assert.equal(trim.ppm, 500);
  trim.setPpm(Number.NaN);
  assert.equal(trim.ppm, 0);

  trim.setPpm(200);
  // 200 ppm of 48 kHz owes a sample every 5,000 samples.
  let taken = 0;
  for (let packet = 0; packet < 100; packet += 1) {
    const step = trim.next(480, RATE, true, 480);
    if (step !== 0) trim.applied(step);
    taken += step;
  }
  assert.equal(taken, 9);
  assert.equal(trim.samples, 9);
  assert.equal(trim.next(48_000, RATE, false, 480), 0, 'only a contiguous packet can take it');

  trim.reset();
  assert.deepEqual([trim.ppm, trim.samples], [0, 0]);
});
