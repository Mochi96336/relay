import assert from 'node:assert/strict';
import test from 'node:test';

import { CaptureRestartBoundaries } from '../src/capture-restart-boundaries.js';

function queued(...samples: number[]) {
  const boundaries = new CaptureRestartBoundaries();
  for (const sample of samples) boundaries.queue(sample);
  return boundaries;
}

test('SE01: empty seams cannot be found or consumed', () => {
  const subject = queued();
  assert.equal(subject.size, 0);
  assert.equal(subject.has(10), false);
  assert.equal(subject.firstForwardCrossing(0, 100), null);
  assert.equal(subject.firstCrossing(100, 0), null);
  assert.equal(subject.consumeThrough(100), false);
});

test('SE02: seam membership is exact, not rounded', () => {
  const subject = queued(10, 20, 30);
  assert.equal(subject.size, 3);
  assert.equal(subject.has(20), true);
  assert.equal(subject.has(20.5), false);
});

test('SE03: out-of-order arrivals still find the first crossed seam', () => {
  const subject = queued(20, 10, 15);
  assert.equal(subject.firstCrossing(0, 30), 10);
  assert.equal(subject.firstCrossing(30, 0), 20);
});

test('SE04: queuing the last seam again is ignored', () => {
  assert.equal(queued(10, 20, 20).size, 2);
});

test('SE05: a duplicate of an earlier seam preserves the existing queue rule', () => {
  const subject = queued(10, 20, 10);
  assert.equal(subject.size, 3);
  subject.trimBefore(11);
  assert.equal(subject.size, 1);
  assert.equal(subject.has(20), true);
});

test('SE06: forward crossing excludes its start and includes its end', () => {
  assert.equal(queued(10, 20, 30).firstForwardCrossing(10, 20), 20);
});

test('SE07: a forward-only query never reverses its interval', () => {
  assert.equal(queued(10, 20, 30).firstForwardCrossing(20, 10), null);
});

test('SE08: backward crossing includes the starting seam', () => {
  assert.equal(queued(10, 20, 30).firstCrossing(30, 10), 30);
});

test('SE09: backward crossing finds the nearest seam in the travel direction', () => {
  assert.equal(queued(10, 20, 30).firstCrossing(29, 10), 20);
});

test('SE10: an unchanged read position crosses no seam', () => {
  assert.equal(queued(10, 20, 30).firstCrossing(10, 10), null);
});

test('SE11: a fractional forward trajectory crosses at its exact endpoint', () => {
  assert.equal(queued(10).firstCrossing(9.5, 10), 10);
});

test('SE12: a fractional backward trajectory can leave an exact seam', () => {
  assert.equal(queued(10).firstCrossing(10, 9.5), 10);
});

test('SE13: trim retains a seam equal to the retention cutoff', () => {
  const subject = queued(10, 20);
  subject.trimBefore(10);
  assert.equal(subject.size, 2);
  assert.equal(subject.has(10), true);
});

test('SE14: trim removes only seams strictly before a fractional cutoff', () => {
  const subject = queued(10, 20);
  subject.trimBefore(10.1);
  assert.equal(subject.size, 1);
  assert.equal(subject.has(10), false);
  assert.equal(subject.has(20), true);
});

test('SE15: rebasing moves both membership and crossing coordinates', () => {
  const subject = queued(10, 20);
  subject.rebase(-5);
  assert.equal(subject.has(5), true);
  assert.equal(subject.has(15), true);
  assert.equal(subject.has(20), false);
  assert.equal(subject.firstCrossing(20, 0), 15);
});

test('SE16: consuming a due seam cannot consume it a second time', () => {
  const subject = queued(10, 20);
  assert.equal(subject.consumeThrough(10), true);
  assert.equal(subject.size, 1);
  assert.equal(subject.consumeThrough(10), false);
  assert.equal(subject.has(20), true);
});

test('SE17: forward consumption retires every due seam', () => {
  const subject = queued(10, 20, 30);
  assert.equal(subject.consumeThrough(100), true);
  assert.equal(subject.size, 0);
});

test('SE18: clear discards a previous capture lifecycle', () => {
  const subject = queued(10);
  subject.clear();
  subject.queue(7);
  assert.equal(subject.size, 1);
  assert.equal(subject.has(10), false);
  assert.equal(subject.has(7), true);
});

test('SE19: an old crossfade leg behind the previous read cannot claim a backward seam', () => {
  const subject = queued(80, 100);
  assert.equal(subject.firstForwardCrossing(100, 90), null);
  assert.equal(subject.firstCrossing(100, 90), 100);
});

test('SE20: retained Mic seams can be revisited without consuming them', () => {
  const subject = queued(10);
  assert.equal(subject.firstCrossing(9, 11), 10);
  assert.equal(subject.firstCrossing(11, 9), 10);
  assert.equal(subject.size, 1);
});

test('rebased seams remain ordered through later insertions, trim and consume', () => {
  const subject = queued(10, 20, 30);
  subject.rebase(0.5);
  subject.queue(15.5);
  assert.equal(subject.firstForwardCrossing(10.5, 20.5), 15.5);
  subject.trimBefore(15.5);
  assert.equal(subject.size, 3);
  assert.equal(subject.consumeThrough(20.5), true);
  assert.equal(subject.size, 1);
  assert.equal(subject.firstCrossing(40, 0), 30.5);
});

test('separate Mic and Backing owners do not share consumed or cleared history', () => {
  const mic = queued(10, 20);
  const backing = queued(10, 20);
  backing.consumeThrough(20);
  assert.equal(mic.firstCrossing(30, 0), 20);
  mic.clear();
  backing.queue(30);
  assert.equal(mic.size, 0);
  assert.equal(backing.has(30), true);
});
