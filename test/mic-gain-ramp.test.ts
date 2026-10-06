import assert from 'node:assert/strict';
import test from 'node:test';

import { MicGainRamp } from '../src/mic-gain-ramp.js';

test('stopped gain changes expose and apply the target immediately without command clamping', () => {
  const subject = new MicGainRamp(48_000);
  assert.equal(subject.targetDb, 24);
  for (const value of [12.5, -6, 100]) {
    subject.setTargetDb(value, false);
    assert.equal(subject.targetDb, value);
    assert.equal(subject.projectDb(0), value);
    assert.equal(subject.advanceDb(), value);
  }
});

for (const rate of [16_000, 44_100, 48_000]) {
  test(`a live gain command follows a 20 ms dB ramp at ${rate} Hz`, () => {
    const subject = new MicGainRamp(rate, 0);
    subject.setTargetDb(12, true);
    assert.equal(subject.targetDb, 12, 'commands read the accepted target immediately');
    assert.equal(subject.projectDb(0), 0, 'samples start from the gain already audible');
    const samples = Math.round(rate * 0.02);
    let previous = 0;
    for (let i = 0; i < samples; i += 1) {
      const projected = subject.projectDb(1);
      const next = subject.advanceDb();
      assert.ok(next > previous && next <= 12);
      assert.ok(Math.abs(next - projected) < 1e-12, 'detector and output use the same gain trajectory');
      if (i < samples - 1) assert.ok(next < 12, 'ramp cannot settle a sample early');
      previous = next;
    }
    assert.equal(previous, 12);
    assert.equal(subject.advanceDb(), 12);
  });
}

test('a new command bends from the current audible gain', () => {
  const subject = new MicGainRamp(48_000, 0);
  subject.setTargetDb(12, true);
  for (let i = 0; i < 480; i += 1) subject.advanceDb();
  const before = subject.projectDb(0);
  assert.ok(Math.abs(before - 6) < 1e-12);
  subject.setTargetDb(-6, true);
  assert.equal(subject.projectDb(0), before, 'retargeting cannot jump to either command target');
  assert.ok(Math.abs(subject.advanceDb() - before) < 0.02);
  for (let i = 1; i < 960; i += 1) subject.advanceDb();
  assert.equal(subject.advanceDb(), -6);
});

test('repeating the accepted target does not restart its ramp', () => {
  const subject = new MicGainRamp(48_000, 0);
  subject.setTargetDb(12, true);
  for (let i = 0; i < 480; i += 1) subject.advanceDb();
  subject.setTargetDb(12, true);
  for (let i = 0; i < 480; i += 1) subject.advanceDb();
  assert.equal(subject.projectDb(0), 12);
});

test('look-ahead projection is bounded and does not consume the audible ramp', () => {
  const subject = new MicGainRamp(48_000, 0);
  subject.setTargetDb(12, true);
  assert.equal(subject.projectDb(-100), 0);
  assert.equal(subject.projectDb(10_000), 12);
  assert.equal(subject.projectDb(0), 0);
  const first = subject.projectDb(1);
  assert.equal(subject.projectDb(0.4), 0);
  assert.equal(subject.projectDb(0.6), first, 'future source offsets use the existing nearest sample rule');
  assert.equal(subject.advanceDb(), first);
});

test('a new epoch discards a partial ramp and starts at current command intent', () => {
  const subject = new MicGainRamp(48_000, 0);
  subject.setTargetDb(12, true);
  subject.advanceDb();
  subject.reset();
  assert.equal(subject.targetDb, 12);
  assert.equal(subject.projectDb(0), 12);
  assert.equal(subject.advanceDb(), 12);
});
