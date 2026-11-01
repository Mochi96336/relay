import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AudioSession } from '../src/audio-session.js';

const RATE = 48_000;
const FRAME_MS = 20;
const PREBUFFER_MS = 600;
// A millisecond is half this tone's period, so a crossfade between read heads
// a millisecond apart cancels it: the dip a jump leaves is as deep as it gets.
const TONE_HZ = 500;
const TONE_AMPLITUDE = 8_000;
const PERIOD_SAMPLES = RATE / TONE_HZ;

function tone(count: number) {
  const pcm = Buffer.alloc(count * 2);
  for (let index = 0; index < count; index += 1) {
    pcm.writeInt16LE(Math.round(TONE_AMPLITUDE * Math.sin((2 * Math.PI * TONE_HZ * index) / RATE)), index * 2);
  }
  return pcm;
}

function makeSession() {
  const session = new AudioSession({
    sampleRate: RATE,
    frameMs: FRAME_MS,
    prebufferMs: PREBUFFER_MS,
    backingGain: 0.65,
    retentionMs: 3_000,
    backingRetentionMs: 1_000,
  });
  session.setMicGainDb(0);
  session.setMicExpected(true);
  session.start(0);
  session.setAlignment({ networkCompensationMs: 100 });
  session.ingestMic({ generation: 1, firstSampleIndex: 0, pcm: tone(RATE * 16) }, RATE, 0);
  return session;
}

/** The quietest single tone period after the first second, against a steady one. */
function envelope(samples: number[]) {
  const from = RATE;
  let steady = 0;
  for (let index = from; index < from + PERIOD_SAMPLES; index += 1) {
    steady = Math.max(steady, Math.abs(samples[index]!));
  }
  let quietest = Infinity;
  for (let start = from; start + PERIOD_SAMPLES <= samples.length; start += PERIOD_SAMPLES) {
    let peak = 0;
    for (let index = start; index < start + PERIOD_SAMPLES; index += 1) {
      peak = Math.max(peak, Math.abs(samples[index]!));
    }
    quietest = Math.min(quietest, peak);
  }
  return { steady, quietest };
}

test('a live uncalibrated fallback target walks the read head without a crossfaded jump', () => {
  const session = makeSession();
  const samples: number[] = [];
  let targetMs = 100;
  for (let outputFrame = 0; outputFrame < 600; outputFrame += 1) {
    const nowMs = outputFrame * FRAME_MS;
    // An estimate 1 ms further every 600 ms, just under the walk rate:
    // twenty-five times the per-frame bound if it were applied at once.
    if (outputFrame > 50 && outputFrame % 30 === 0) {
      targetMs += 1;
      session.slewNetworkCompensationTo(targetMs);
    }
    session.drain((pcm) => {
      for (let index = 0; index < pcm.byteLength / 2; index += 1) samples.push(pcm.readInt16LE(index * 2));
    }, PREBUFFER_MS + nowMs, 1);
  }

  assert.ok(targetMs > 115, 'fixture must move the target well past one step');
  assert.equal(session.alignment.networkCompensationMs, targetMs);
  const { steady, quietest } = envelope(samples);
  assert.ok(steady > TONE_AMPLITUDE * 0.9, `fixture tone should be audible, saw ${steady}`);
  assert.ok(quietest > steady * 0.9, `the walk dipped the tone to ${quietest} of ${steady}`);
});

test('setAlignment stays immediate and cancels a pending fallback walk', () => {
  const session = makeSession();
  session.drain(() => {}, PREBUFFER_MS, 1);
  session.slewNetworkCompensationTo(160);
  session.drain(() => {}, PREBUFFER_MS + FRAME_MS, 1);
  const walked = session.alignment.networkCompensationMs;
  assert.ok(walked > 100 && walked < 101, `one frame walks at most the slew bound, saw ${walked}`);

  session.setAlignment({ networkCompensationMs: 120 });
  session.drain(() => {}, PREBUFFER_MS + 2 * FRAME_MS, 1);
  assert.equal(session.alignment.networkCompensationMs, 120);
});

test('a stopped session takes the fallback target at once', () => {
  const session = makeSession();
  session.stop();
  session.slewNetworkCompensationTo(140);
  assert.equal(session.alignment.networkCompensationMs, 140);
});

test('re-targeting a walk at the current value stops it where it is (the server holds this way)', () => {
  const session = makeSession();
  session.drain(() => {}, PREBUFFER_MS, 1);
  session.slewNetworkCompensationTo(120);
  session.drain(() => {}, PREBUFFER_MS + FRAME_MS, 1);
  const held = session.alignment.networkCompensationMs;
  session.slewNetworkCompensationTo(held);
  assert.equal(session.networkCompensationTargetMs, null);
  for (let frame = 2; frame < 20; frame += 1) session.drain(() => {}, PREBUFFER_MS + frame * FRAME_MS, 1);
  assert.equal(session.alignment.networkCompensationMs, held);
});
