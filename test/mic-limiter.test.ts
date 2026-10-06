import assert from 'node:assert/strict';
import test from 'node:test';

import { MicLimiter } from '../src/mic-limiter.js';

const RATE = 48_000;

test('quiet PCM passes through the limiter unchanged', () => {
  const subject = new MicLimiter(RATE);
  for (const value of [0, 0.1, -0.2, 0.8, -0.8]) {
    assert.equal(subject.apply(value, value), value);
  }
  assert.equal(subject.limiting, false);
  assert.equal(subject.heavilyLimiting, false);
});

test('a future peak engages reduction before the transient reaches output', () => {
  const subject = new MicLimiter(RATE);
  assert.equal(subject.lookaheadSamples, 144);
  for (let i = 0; i < subject.lookaheadSamples; i += 1) subject.apply(0, 4);
  const transient = subject.apply(4, 4);
  assert.ok(transient < subject.ceiling * 1.025, `look-ahead left the peak at ${transient}`);
  assert.equal(subject.heavilyLimiting, true);
});

test('a hot replacement can seed safe dynamics before its first audible sample', () => {
  const subject = new MicLimiter(RATE);
  subject.seedPeak(4);
  assert.equal(subject.apply(4, 4), subject.ceiling);
  assert.equal(subject.apply(-4, -4), -subject.ceiling);
  assert.equal(subject.limiting, true);
  assert.equal(subject.heavilyLimiting, true);
});

test('limiter release remains smooth and eventually restores quiet PCM', () => {
  const subject = new MicLimiter(RATE);
  subject.seedPeak(4);
  let previous = subject.apply(0.2, 0.2);
  assert.ok(previous < 0.1);
  for (let i = 0; i < RATE * 2; i += 1) {
    const next = subject.apply(0.2, 0.2);
    assert.ok(next >= previous, 'quiet recovery cannot introduce a new gain reduction');
    assert.ok(next - previous < 0.0001, 'release must not jump to unity');
    previous = next;
  }
  assert.ok(Math.abs(previous - 0.2) < 0.0001);
  assert.equal(subject.limiting, false);
});

test('protective reduction and audible heavy limiting remain distinct', () => {
  const subject = new MicLimiter(RATE);
  const lightPeak = subject.ceiling * 10 ** (0.2 / 20);
  subject.seedPeak(lightPeak);
  subject.apply(lightPeak, lightPeak);
  assert.equal(subject.limiting, true);
  assert.equal(subject.heavilyLimiting, false);
  const heavyPeak = subject.ceiling * 10 ** (6 / 20);
  subject.seedPeak(heavyPeak);
  subject.apply(heavyPeak, heavyPeak);
  assert.equal(subject.heavilyLimiting, true);
});

test('reset retires detector history without changing the limiter configuration', () => {
  const subject = new MicLimiter(44_100);
  assert.equal(subject.lookaheadSamples, 132);
  subject.seedPeak(4);
  subject.reset();
  assert.equal(subject.apply(0.2, 0.2), 0.2);
  assert.equal(subject.limiting, false);
  assert.equal(subject.heavilyLimiting, false);
  assert.equal(subject.lookaheadSamples, 132);
});
