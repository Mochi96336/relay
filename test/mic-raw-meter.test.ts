import assert from 'node:assert/strict';
import test from 'node:test';

import { MicRawMeter } from '../src/mic-raw-meter.js';

const RATE = 48_000;

function constant(value: number, samples = RATE) {
  return new Int16Array(samples).fill(value);
}

test('the raw meter has no level evidence before nonzero PCM arrives', () => {
  const subject = new MicRawMeter(RATE);
  subject.observe(new Int16Array(0));
  assert.equal(subject.peakDbfs, null);
  assert.equal(subject.rmsDbfs, null);
  subject.observe(constant(0));
  assert.equal(subject.peakDbfs, null);
  assert.equal(subject.rmsDbfs, null);
});

test('raw PCM peak and power are reported in dBFS, including the negative rail', () => {
  const subject = new MicRawMeter(RATE);
  subject.observe(constant(-32_768));
  assert.equal(subject.peakDbfs, 0);
  assert.equal(subject.rmsDbfs, 0);
  subject.reset();
  subject.observe(constant(16_384));
  const halfScaleDb = 20 * Math.log10(0.5);
  assert.equal(subject.peakDbfs, halfScaleDb);
  assert.equal(subject.rmsDbfs, halfScaleDb);
});

test('peak decay follows audio duration with a two-second half-life', () => {
  const whole = new MicRawMeter(RATE);
  const fragmented = new MicRawMeter(RATE);
  for (const subject of [whole, fragmented]) subject.observe(constant(16_384));
  whole.observe(constant(0, RATE * 2));
  for (let i = 0; i < 100; i += 1) fragmented.observe(constant(0, RATE / 50));
  const quarterScaleDb = 20 * Math.log10(0.25);
  assert.equal(whole.peakDbfs, quarterScaleDb);
  assert.ok(Math.abs(fragmented.peakDbfs! - quarterScaleDb) < 1e-10);
});

test('constant-level RMS is independent of capture packet size', () => {
  const whole = new MicRawMeter(RATE);
  const fragmented = new MicRawMeter(RATE);
  whole.observe(constant(8_192));
  for (let i = 0; i < 50; i += 1) fragmented.observe(constant(8_192, RATE / 50));
  assert.equal(fragmented.rmsDbfs, whole.rmsDbfs);
  assert.equal(fragmented.peakDbfs, whole.peakDbfs);
});

test('capture replacement retires the previous singer level immediately', () => {
  const subject = new MicRawMeter(RATE);
  subject.observe(constant(-32_768));
  subject.reset();
  assert.equal(subject.peakDbfs, null);
  assert.equal(subject.rmsDbfs, null);
  subject.observe(constant(1_024));
  assert.equal(subject.peakDbfs, 20 * Math.log10(1 / 32));
  assert.equal(subject.rmsDbfs, subject.peakDbfs);
});
