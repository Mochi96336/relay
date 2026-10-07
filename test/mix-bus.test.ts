import assert from 'node:assert/strict';
import test from 'node:test';

import { MixBus, type BusSource } from '../src/mix-bus.js';

const RATE = 48_000;
const BACKING_GAIN = 0.65;
const VOICE_CEILING = 10 ** (-1 / 20);
const JOIN_SAMPLES = 480;

function bus(sampleRate = RATE, backingGain = BACKING_GAIN, voiceCeiling = VOICE_CEILING) {
  return new MixBus({ sampleRate, backingGain, voiceCeiling });
}

function close(actual: number, expected: number, message?: string) {
  assert.ok(Math.abs(actual - expected) < 1e-12, message ?? `${actual} != ${expected}`);
}

function expectSource(subject: MixBus, source: BusSource, expected: boolean, running = true) {
  if (source === 'mic') subject.setMicExpected(expected, running);
  else subject.setBackingExpected(expected, running);
}

function releaseHold(subject: MixBus, source: BusSource) {
  if (source === 'mic') subject.releaseMicHold();
  else subject.releaseBackingHold();
}

function held(subject: MixBus, source: BusSource) {
  return source === 'mic' ? subject.micReleaseHeld : subject.backingReleaseHeld;
}

function joining(source: BusSource) {
  const subject = bus();
  expectSource(subject, source === 'mic' ? 'backing' : 'mic', true);
  expectSource(subject, source, true);
  return subject;
}

for (const rate of [16_000, 44_100, 48_000]) {
  test(`song duck and headroom ramp both ways over 150 ms at ${rate} Hz`, () => {
    const subject = bus(rate);
    subject.setBackingExpected(true, true);
    assert.equal(subject.duckTarget(), 0);
    assert.equal(subject.songGain, 1);
    assert.equal(subject.headroomGain, 1);
    subject.setMicExpected(true, true);
    assert.equal(subject.duckTarget(), 1);
    const samples = Math.round(rate * 0.15);
    for (let i = 0; i < samples - 1; i += 1) subject.advanceDuck(1);
    assert.ok(subject.songGain > BACKING_GAIN, 'duck must not settle a sample early');
    subject.advanceDuck(1);
    close(subject.songGain, BACKING_GAIN);
    close(subject.headroomGain, 1 / (VOICE_CEILING + BACKING_GAIN));
    subject.advanceDuck(1);

    subject.setMicExpected(false, true);
    assert.equal(subject.duckTarget(), 1, 'retained voice still owns the bus');
    subject.releaseMicHold();
    assert.equal(subject.duckTarget(), 0);
    for (let i = 0; i < samples - 1; i += 1) subject.advanceDuck(0);
    assert.ok(subject.songGain < 1, 'return must not settle a sample early');
    subject.advanceDuck(0);
    close(subject.songGain, 1);
    close(subject.headroomGain, 1);
  });
}

test('reversing a partial song duck continues from the gain already heard', () => {
  const subject = joining('mic');
  for (let i = 0; i < 3_600; i += 1) subject.advanceDuck(1);
  close(subject.songGain, (1 + BACKING_GAIN) / 2);
  subject.setMicExpected(false, true);
  subject.releaseMicHold();
  const before = subject.songGain;
  subject.advanceDuck(subject.duckTarget());
  close(subject.songGain - before, (1 - BACKING_GAIN) / 7_200);
});

for (const source of ['mic', 'backing'] as const) {
  test(`${source} joins from the audible peer once its own PCM is real`, () => {
    const subject = joining(source);
    const peer = source === 'mic' ? 0.4 : 0.5;
    const waiting = subject.mixSample(
      source === 'mic' ? 0 : 0.5, source === 'backing' ? 0 : 0.4,
      true, source === 'mic', source === 'backing',
    );
    close(waiting, peer);
    assert.equal(subject.joinSafetyActive, null, 'registration alone does not start the join');
    const safeSum = 0.9 / (VOICE_CEILING + 1);
    const first = subject.mixSample(0.5, 0.4, true, false, false);
    assert.equal(subject.joinSafetyActive, source);
    close(first, peer * (1 - 1 / JOIN_SAMPLES) + safeSum / JOIN_SAMPLES);
    expectSource(subject, source, true);
    let value = subject.mixSample(0.5, 0.4, true, false, false);
    close(value, peer * (1 - 2 / JOIN_SAMPLES) + safeSum * (2 / JOIN_SAMPLES),
      'repeated expectation does not restart an active join');
    for (let i = 2; i < JOIN_SAMPLES; i += 1) {
      value = subject.mixSample(0.5, 0.4, true, false, false);
    }
    close(value, safeSum);
    assert.equal(subject.joinSafetyActive, source, 'safety still owns the bus until the slower duck settles');
  });

  test(`${source} enters through silence when its peer is missing`, () => {
    const subject = joining(source);
    const voice = source === 'mic' ? 0.5 : 0;
    const song = source === 'backing' ? 0.4 : 0;
    const first = subject.mixSample(voice, song, true, source === 'backing', source === 'mic');
    assert.equal(subject.joinSafetyActive, source, 'the peer must not gate the joining source');
    close(first, (voice + song) / (VOICE_CEILING + 1) / JOIN_SAMPLES);
  });

  test(`${source} leaving before its first PCM cancels the pending join`, () => {
    const subject = joining(source);
    expectSource(subject, source, false);
    assert.equal(held(subject, source), true);
    assert.equal(subject.twoSourceOwnership, true);
    subject.mixSample(0.5, 0.4, true, false, false);
    assert.equal(subject.joinSafetyActive, null, 'a cancelled registration must not join on late PCM');
    expectSource(subject, source, false);
    assert.equal(held(subject, source), true, 'repeated cancellation keeps the release hold');
    releaseHold(subject, source);
    assert.equal(subject.twoSourceOwnership, false);
    assert.equal(subject.duckTarget(), 0);
  });

  test(`${source} returning before release completes continues the same bus`, () => {
    const subject = bus();
    subject.setMicExpected(true, false);
    subject.setBackingExpected(true, false);
    subject.reset();
    expectSource(subject, source, false);
    expectSource(subject, source, true);
    assert.equal(held(subject, source), false);
    subject.mixSample(0.5, 0.4 * subject.songGain, true, false, false);
    assert.equal(subject.joinSafetyActive, null, 'no new join while the old source is still audible');
    expectSource(subject, source, false);
    releaseHold(subject, source);
    expectSource(subject, source, true);
    subject.mixSample(0.5, 0.4 * subject.songGain, true, false, false);
    assert.equal(subject.joinSafetyActive, source, 'return after release owns a fresh join');
  });

  test(`${source} join stays safe through a hold and exits to the remaining peer`, () => {
    const subject = joining(source);
    subject.mixSample(0.5, 0.4, true, false, false);
    expectSource(subject, source, false);
    const voice = source === 'mic' ? 0 : 0.5;
    const song = source === 'backing' ? 0 : 0.4;
    for (let i = 1; i < JOIN_SAMPLES; i += 1) {
      subject.mixSample(voice, song, subject.twoSourceOwnership, source === 'mic', source === 'backing');
    }
    assert.equal(subject.joinSafetyActive, source);
    assert.equal(subject.duckTarget(), 1, 'the mixer decides when a retained tail has completed');
    releaseHold(subject, source);
    let value = 0;
    // Accumulated floating-point steps can need one final sample to reach
    // exactly zero, matching the existing mixer ramp.
    for (let i = 0; i <= JOIN_SAMPLES; i += 1) {
      value = subject.mixSample(voice, song, subject.twoSourceOwnership, source === 'mic', source === 'backing');
    }
    close(value, voice + song);
    assert.equal(subject.joinSafetyActive, null);
  });

  test(`${source} joining a peer held after departure still uses the safe bus`, () => {
    const subject = bus();
    const peer = source === 'mic' ? 'backing' : 'mic';
    expectSource(subject, peer, true);
    expectSource(subject, peer, false);
    expectSource(subject, source, true);
    subject.mixSample(0.5, 0.4, subject.twoSourceOwnership, false, false);
    assert.equal(subject.joinSafetyActive, source);
  });
}

test('a hold completed by this sample keeps its captured ownership until the following sample', () => {
  const subject = joining('mic');
  subject.mixSample(0.5, 0.4, true, false, false);
  subject.setMicExpected(false, true);
  const capturedOwnership = subject.twoSourceOwnership;
  subject.releaseMicHold();
  assert.equal(subject.twoSourceOwnership, false);
  const lastHeld = subject.mixSample(0, 0.4, capturedOwnership, true, false);
  assert.ok(lastHeld < 0.4, 'this sample still moves toward the protected sum');
  const firstReleased = subject.mixSample(0, 0.4, subject.twoSourceOwnership, true, false);
  assert.ok(firstReleased > lastHeld, 'the following sample starts unwinding the join');
});

test('both missing sources unwind an active join to literal silence', () => {
  const subject = joining('mic');
  subject.mixSample(0.5, 0.4, true, false, false);
  subject.setMicExpected(false, true);
  subject.setBackingExpected(false, true);
  subject.releaseMicHold();
  subject.releaseBackingHold();
  assert.equal(subject.mixSample(0, 0, subject.twoSourceOwnership, true, true), 0);
  assert.equal(subject.joinSafetyActive, null);
});

test('an epoch reset retires a pending registration join as well as an active one', () => {
  const subject = joining('mic');
  subject.reset();
  const value = subject.mixSample(0.5, 0.4 * subject.songGain, true, false, false);
  assert.equal(subject.joinSafetyActive, null);
  assert.equal(value, (0.5 + 0.4 * subject.songGain) * subject.headroomGain);
});

test('join safety hands back to the ordinary sum without a seam at steady duck', () => {
  const subject = joining('mic');
  for (let i = 0; i < 8_000; i += 1) {
    subject.advanceDuck(1);
    const value = subject.mixSample(0.5, 0.4 * subject.songGain, true, false, false);
    assert.ok(Math.abs(value) <= 1, 'every join sample stays inside the bus bounds');
    if (subject.joinSafetyActive === null) {
      const steady = (0.5 + 0.4 * subject.songGain) * subject.headroomGain;
      assert.equal(value, steady, 'handoff sample is bit-exact with the ordinary path');
      assert.equal(subject.mixSample(0.5, 0.4 * subject.songGain, true, false, false), steady);
      return;
    }
  }
  assert.fail('join must complete once both ramps settle');
});

test('a new epoch clears joins and holds, and starts from current expectations', () => {
  const subject = joining('mic');
  subject.mixSample(0.5, 0.4, true, false, false);
  subject.setBackingExpected(false, true);
  subject.reset();
  assert.equal(subject.micExpected, true);
  assert.equal(subject.backingExpected, false);
  assert.equal(subject.micReleaseHeld, false);
  assert.equal(subject.backingReleaseHeld, false);
  assert.equal(subject.joinSafetyActive, null);
  assert.equal(subject.songGain, 1);
  assert.equal(subject.headroomGain, 1);
  subject.mixSample(0.5, 0, false, false, true);
  assert.equal(subject.joinSafetyActive, null);
  subject.setBackingExpected(true, false);
  subject.reset();
  close(subject.songGain, BACKING_GAIN);
  close(subject.headroomGain, 1 / (VOICE_CEILING + BACKING_GAIN));
  subject.setMicExpected(false, false);
  subject.setBackingExpected(false, false);
  assert.equal(subject.micReleaseHeld, false, 'stopped mix has no audible release tail');
  assert.equal(subject.backingReleaseHeld, false);
});

for (const gain of [0, 0.5, -0.5, -0.9]) {
  test(`steady headroom reserves only the linear sum needed for backing gain ${gain}`, () => {
    const ceiling = 0.25;
    const subject = bus(RATE, gain, ceiling);
    subject.setMicExpected(true, false);
    subject.setBackingExpected(true, false);
    subject.reset();
    const expected = 1 / Math.max(1, ceiling + Math.abs(gain));
    close(subject.songGain, gain);
    close(subject.headroomGain, expected);
    close(subject.mixSample(0.2, gain, true, false, false), (0.2 + gain) * expected);
  });
}
