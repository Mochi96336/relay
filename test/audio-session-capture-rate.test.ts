import assert from 'node:assert/strict';
import test from 'node:test';

import { AudioSession } from '../src/audio-session.js';
import type { PcmFrame } from '../src/pcm-frame.js';

const RATE = 48_000;

function makeSession() {
  return new AudioSession({
    sampleRate: RATE,
    frameMs: 20,
    prebufferMs: 0,
    backingGain: 1,
    retentionMs: 5_000,
  });
}

function pcm(samples: number, value: number) {
  const buffer = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) buffer.writeInt16LE(value, i * 2);
  return buffer;
}

function frame(
  generation: number,
  firstSampleIndex: number,
  samples: number,
  value: number,
): PcmFrame {
  return { generation, firstSampleIndex, pcm: pcm(samples, value) };
}

function makeTransitionSession() {
  return new AudioSession({
    sampleRate: RATE,
    frameMs: 20,
    prebufferMs: 40,
    backingGain: 1,
    retentionMs: 5_000,
  });
}

function drainOne(session: AudioSession, nowMs: number) {
  const outputs: Buffer[] = [];
  const drained = session.drain((output) => {
    outputs.push(output);
  }, nowMs, 1);
  assert.equal(drained, 1);
  assert.equal(outputs.length, 1);
  return outputs[0]!;
}

test('reused Mic generation at a different source rate re-anchors without restarting the mix epoch', () => {
  const session = makeSession();
  session.start(0);

  const backing = session.ingestBacking(frame(21, 0, 480, 111), RATE, 0);
  const firstMic = session.ingestMic(frame(12, 0, 480, 222), RATE, 0);
  const mixGeneration = session.generation;

  assert.equal(backing.captureRestarted, false);
  assert.equal(firstMic.captureRestarted, false);
  assert.equal(session.micGeneration, 12);
  assert.equal(session.backingGeneration, 21);

  const replacement = session.ingestMic(frame(12, 0, 441, 333), 44_100, 1_000);

  assert.equal(replacement.captureRestarted, true);
  assert.equal(session.generation, mixGeneration, 'an active Take must keep the same mix generation');
  assert.equal(session.micGeneration, 12, 'wire generation may be reused by the contradictory capture');
  assert.equal(session.backingGeneration, 21, 'the unrelated backing timeline remains in the same mix epoch');
  assert.equal(replacement.start, 47_520);
  assert.equal(
    replacement.samples.length,
    479,
    '44.1 kHz upsampling defers the final target sample until the next source endpoint exists',
  );
  assert.equal(session.readMic(replacement.start, 1)[0], 333);
  assert.equal(session.readBacking(0, 1)[0], 111);
});

test('reused Backing generation at a different source rate re-anchors without restarting the mix epoch', () => {
  const session = makeSession();
  session.start(0);

  const firstBacking = session.ingestBacking(frame(21, 0, 480, 111), RATE, 0);
  session.ingestMic(frame(12, 0, 480, 222), RATE, 0);
  const mixGeneration = session.generation;

  assert.equal(firstBacking.captureRestarted, false);
  const replacement = session.ingestBacking(frame(21, 0, 441, 333), 44_100, 1_000);

  assert.equal(replacement.captureRestarted, true);
  assert.equal(session.generation, mixGeneration, 'Backing capture replacement must keep the mix epoch');
  assert.equal(session.backingGeneration, 21, 'wire generation may be reused by the contradictory capture');
  assert.equal(session.micGeneration, 12, 'the unrelated Mic timeline remains in the same mix epoch');
  assert.equal(replacement.start, 47_520);
  assert.equal(
    replacement.samples.length,
    479,
    'capture restart keeps one future-dependent target sample pending instead of clamping it',
  );
  assert.equal(session.readBacking(replacement.start, 1)[0], 333);
  assert.equal(session.readMic(0, 1)[0], 222);

  const continuation = session.ingestBacking(frame(21, 441, 441, 444), 44_100, 1_010);
  assert.equal(continuation.captureRestarted, false, 'the source-rate restart signal is one-shot');
  assert.equal(
    continuation.start,
    48_000,
    'frame-scoped evidence still begins where the current source frame begins',
  );
  assert.equal(
    continuation.samples[0],
    444,
    'the deferred previous-frame prefix is not mislabeled as current-frame evidence',
  );
  const deferredSourcePosition = (479 * 44_100) / RATE;
  const deferredFraction = deferredSourcePosition - Math.floor(deferredSourcePosition);
  const expectedDeferred = Math.round(333 + (444 - 333) * deferredFraction);
  assert.equal(
    session.readBacking(47_999, 1)[0],
    expectedDeferred,
    'the timeline still keeps the deferred boundary interpolation at its true session position',
  );
  assert.equal(session.readBacking(48_000, 1)[0], 444);
});

test('a genuine Mic generation replacement reports the same capture restart signal', () => {
  const session = makeSession();
  session.start(0);
  const first = session.ingestMic(frame(12, 0, 480, 222), RATE, 0);
  const mixGeneration = session.generation;

  assert.equal(first.captureRestarted, false);
  const replacement = session.ingestMic(frame(13, 0, 441, 333), 44_100, 1_000);

  assert.equal(replacement.captureRestarted, true);
  assert.equal(session.generation, mixGeneration);
  assert.equal(session.micGeneration, 13);
  assert.equal(replacement.start, 47_520);
  assert.equal(session.readMic(replacement.start, 1)[0], 333);
});


test('Mic generation restart de-clicks the audible old/new capture splice without rewriting PCM', () => {
  const session = makeTransitionSession();
  const chunk = Math.round(RATE * 0.02);
  const fadeSamples = Math.round(RATE * 0.002);
  const amplitude = 12_000;

  session.setMicGainDb(0);
  session.setMicExpected(true);
  session.start(0);
  session.ingestMic(frame(12, 0, chunk, amplitude), RATE, 20);
  session.ingestMic(frame(12, chunk, chunk, amplitude), RATE, 40);
  session.ingestMic(frame(12, chunk * 2, chunk, amplitude), RATE, 60);

  // Queue replacement PCM before any drain so Mic frontier correction never
  // enters this seam-only fixture. One continuation frame gives the restart
  // output frame real source headroom beyond the boundary.
  const replacement = session.ingestMic(frame(13, 0, chunk, -amplitude), RATE, 80);
  assert.equal(replacement.captureRestarted, true);
  assert.equal(replacement.start, chunk * 3);
  session.ingestMic(frame(13, chunk, chunk, -amplitude), RATE, 81);
  assert.equal(
    session.readMic(replacement.start, 1)[0],
    -amplitude,
    'restart smoothing must not rewrite raw replacement PCM',
  );

  drainOne(session, 40);
  drainOne(session, 60);
  const before = drainOne(session, 80);
  const beforeLast = before.readInt16LE((chunk - 1) * 2);
  assert.ok(Math.abs(beforeLast - amplitude) <= 1);

  const resumed = drainOne(session, 100);
  assert.ok(
    Math.abs(resumed.readInt16LE(0) - beforeLast) <= 1,
    'the first new-generation Mic sample continues the last audible old-generation edge',
  );
  assert.ok(
    Math.abs(resumed.readInt16LE((fadeSamples - 1) * 2) + amplitude) <= 1,
    'the new-generation Mic waveform is reached inside the 2 ms output-only transition',
  );
  assert.ok(Math.abs(resumed.readInt16LE(fadeSamples * 2) + amplitude) <= 1);
});

test('multiple queued Mic capture restarts keep every unread audible boundary', () => {
  const session = makeTransitionSession();
  const chunk = Math.round(RATE * 0.02);
  const fadeSamples = Math.round(RATE * 0.002);
  const amplitude = 12_000;

  session.setMicGainDb(0);
  session.setMicExpected(true);
  session.start(0);
  session.ingestMic(frame(12, 0, chunk, amplitude), RATE, 20);
  session.ingestMic(frame(12, chunk, chunk, amplitude), RATE, 40);
  session.ingestMic(frame(12, chunk * 2, chunk, amplitude), RATE, 60);

  const firstRestart = session.ingestMic(frame(13, 0, chunk, -amplitude), RATE, 80);
  assert.equal(firstRestart.captureRestarted, true);
  assert.equal(firstRestart.start, chunk * 3);
  session.ingestMic(frame(13, chunk, chunk, -amplitude), RATE, 81);

  // A second capture clock arrives before the mixer reaches the first boundary.
  // Both seams must remain pending instead of the later restart overwriting A.
  const secondRestart = session.ingestMic(frame(14, 0, chunk, amplitude / 2), RATE, 82);
  assert.equal(secondRestart.captureRestarted, true);
  assert.equal(secondRestart.start, chunk * 5);
  assert.equal(
    secondRestart.samples.length,
    0,
    'a fast restart may be fully overlapped by still-queued old-capture PCM',
  );
  session.ingestMic(frame(14, chunk, chunk, amplitude / 2), RATE, 83);
  session.ingestMic(frame(14, chunk * 2, chunk, amplitude / 2), RATE, 84);
  session.ingestMic(frame(14, chunk * 3, chunk, amplitude / 2), RATE, 85);

  // Both restart boundaries are now queued before the mixer emits anything.
  // The extended frontier keeps Mic read-head safety out of this regression.
  drainOne(session, 40);
  drainOne(session, 60);
  const oldTail = drainOne(session, 80);
  const oldLast = oldTail.readInt16LE((chunk - 1) * 2);
  assert.ok(Math.abs(oldLast - amplitude) <= 1);

  const first = drainOne(session, 100);
  assert.ok(
    Math.abs(first.readInt16LE(0) - oldLast) <= 1,
    'first queued restart must continue the old audible edge',
  );
  assert.ok(
    Math.abs(first.readInt16LE((fadeSamples - 1) * 2) + amplitude) <= 1,
    'first queued restart must reach generation 13 inside 2 ms',
  );

  const between = drainOne(session, 120);
  assert.ok(Math.abs(between.readInt16LE((chunk - 1) * 2) + amplitude) <= 1);

  const second = drainOne(session, 140);
  assert.ok(
    Math.abs(second.readInt16LE(0) + amplitude) <= 1,
    'second queued restart must continue generation 13 rather than being lost',
  );
  assert.ok(
    Math.abs(second.readInt16LE((fadeSamples - 1) * 2) - amplitude / 2) <= 1,
    'second queued restart must reach generation 14 inside 2 ms',
  );
});

test('sub-2ms Mic restart chains stay continuous when the replacement target changes mid-fade', () => {
  const session = makeTransitionSession();
  const chunk = Math.round(RATE * 0.02);
  const sourceChunk = Math.round(44_100 * 0.02);

  session.setMicGainDb(0);
  session.setMicExpected(true);
  session.start(0);

  // Build exactly 160 ms of stable capture so the three following re-anchors
  // reproduce the 959 -> 48 -> 912 sample restart chain found by the seeded
  // invariant. The middle capture is shorter than the production 2 ms fade.
  for (let index = 0; index < 8; index += 1) {
    session.ingestMic(frame(1, index * chunk, chunk, 12_000), RATE, index * 20);
  }
  const a = session.ingestMic(frame(2, 0, sourceChunk, -6_000), 44_100, 180);
  const b = session.ingestMic(frame(3, 0, sourceChunk, 6_000), 44_100, 181);
  const d = session.ingestMic(frame(4, 0, sourceChunk, -6_000), 44_100, 200);
  assert.equal(a.captureRestarted, true);
  assert.equal(b.captureRestarted, true);
  assert.equal(d.captureRestarted, true);
  assert.equal(b.samples.length, 48, 'fixture must keep the sub-2ms intermediate capture');
  assert.equal(d.start, 8_687, 'fixture must reproduce the overlapping restart frontier');

  const outputs: Buffer[] = [];
  for (let nowMs = 40; nowMs <= 220; nowMs += 20) {
    outputs.push(drainOne(session, nowMs));
  }

  let maxStep = 0;
  let previous: number | null = null;
  for (const output of outputs) {
    for (let index = 0; index < output.byteLength / 2; index += 1) {
      const value = output.readInt16LE(index * 2);
      if (previous !== null) maxStep = Math.max(maxStep, Math.abs(value - previous));
      previous = value;
    }
  }
  assert.ok(
    maxStep < 1_518,
    `overlapping Mic restart transitions emitted a hard splice: ${maxStep}`,
  );
});

test('a short Backing replacement hands an unfinished restart fade to source-missing continuity', () => {
  const session = makeTransitionSession();
  const chunk = Math.round(RATE * 0.02);
  const sourceChunk = Math.round(44_100 * 0.02);

  session.setBackingExpected(true);
  session.start(0);
  for (let index = 0; index < 8; index += 1) {
    session.ingestBacking(frame(1, index * chunk, chunk, -6_000), RATE, index * 20);
  }

  session.ingestBacking(frame(2, 0, sourceChunk, 6_000), 44_100, 180);
  const short = session.ingestBacking(frame(3, 0, sourceChunk, -6_000), 44_100, 181);
  assert.equal(short.captureRestarted, true);
  assert.equal(short.samples.length, 48, 'fixture must end the replacement before the 2 ms fade finishes');

  const outputs: Buffer[] = [];
  for (let nowMs = 40; nowMs <= 220; nowMs += 20) {
    outputs.push(drainOne(session, nowMs));
  }

  let maxStep = 0;
  let previous: number | null = null;
  for (const output of outputs) {
    for (let index = 0; index < output.byteLength / 2; index += 1) {
      const value = output.readInt16LE(index * 2);
      if (previous !== null) maxStep = Math.max(maxStep, Math.abs(value - previous));
      previous = value;
    }
  }
  assert.ok(
    maxStep < 1_518,
    `short Backing replacement fell into missing source with a hard splice: ${maxStep}`,
  );
});

test('Backing source-rate restart de-clicks the audible splice while keeping resampled history exact', () => {
  const session = makeTransitionSession();
  const chunk = Math.round(RATE * 0.02);
  const sourceChunk = Math.round(44_100 * 0.02);
  const fadeSamples = Math.round(RATE * 0.002);
  const amplitude = 12_000;

  session.setBackingExpected(true);
  session.start(0);
  session.ingestBacking(frame(21, 0, chunk, amplitude), RATE, 20);
  session.ingestBacking(frame(21, chunk, chunk, amplitude), RATE, 40);
  session.ingestBacking(frame(21, chunk * 2, chunk, amplitude), RATE, 60);

  drainOne(session, 40);
  drainOne(session, 60);
  const before = drainOne(session, 80);
  const beforeLast = before.readInt16LE((chunk - 1) * 2);
  assert.ok(Math.abs(beforeLast - amplitude) <= 1);

  const replacement = session.ingestBacking(frame(21, 0, sourceChunk, -amplitude), 44_100, 80);
  assert.equal(replacement.captureRestarted, true);
  assert.equal(replacement.start, chunk * 3);
  session.ingestBacking(
    frame(21, sourceChunk, sourceChunk, -amplitude),
    44_100,
    81,
  );
  assert.equal(
    session.readBacking(replacement.start, 1)[0],
    -amplitude,
    'restart smoothing must not rewrite raw resampled Backing PCM',
  );

  const resumed = drainOne(session, 100);
  assert.ok(
    Math.abs(resumed.readInt16LE(0) - beforeLast) <= 1,
    'the first new-rate Backing sample continues the last audible old-rate edge',
  );
  assert.ok(
    Math.abs(resumed.readInt16LE((fadeSamples - 1) * 2) + amplitude) <= 1,
    'the new-rate Backing waveform is reached inside the 2 ms output-only transition',
  );
  assert.ok(Math.abs(resumed.readInt16LE(fadeSamples * 2) + amplitude) <= 1);
});


test('explicit media replacement retires Mic PCM without deferring a restart signal to PCM', () => {
  const session = makeSession();
  session.start(0);

  session.ingestBacking(frame(21, 0, 480, 111), RATE, 0);
  session.ingestMic(frame(12, 0, 480, 222), RATE, 0);
  const mixGeneration = session.generation;

  session.retireMicCapture();
  assert.equal(session.readMic(0, 1)[0], 0, 'retired capture PCM must disappear at bind time');
  assert.equal(session.readBacking(0, 1)[0], 111, 'capture retirement must not disturb Backing');

  const replacement = session.ingestMic(frame(12, 0, 480, 333), RATE, 1_000);
  assert.equal(
    replacement.captureRestarted,
    false,
    'bind-proven replacement is reported synchronously by publisher activation, not replayed by first PCM',
  );
  assert.equal(session.generation, mixGeneration, 'capture replacement must not restart the mix epoch');
  assert.equal(session.micGeneration, 12);
  assert.equal(session.backingGeneration, 21);
  assert.equal(replacement.start, 47_520);
  assert.equal(session.readMic(replacement.start, 1)[0], 333);

  const continuation = session.ingestMic(frame(12, 480, 480, 444), RATE, 1_010);
  assert.equal(continuation.captureRestarted, false);
});


test('bind-time Mic retirement de-clicks both sides without retaining retired PCM', () => {
  const session = makeTransitionSession();
  const chunk = Math.round(RATE * 0.02);
  const fadeSamples = Math.round(RATE * 0.002);
  const amplitude = 12_000;

  session.setMicGainDb(0);
  session.setMicExpected(true);
  session.start(0);
  session.ingestMic(frame(12, 0, chunk, amplitude), RATE, 20);

  const before = drainOne(session, 40);
  assert.equal(before.readInt16LE((chunk - 1) * 2), amplitude);

  session.retireMicCapture();
  assert.equal(session.readMic(0, 1)[0], 0, 'retired Mic PCM still disappears synchronously at bind time');

  const replacement = session.ingestMic(frame(13, 0, chunk, amplitude), RATE, 60);
  assert.equal(replacement.captureRestarted, false, 'bind-time retirement still owns the restart signal');

  const gap = drainOne(session, 60);
  assert.equal(gap.readInt16LE(0), amplitude, 'the first post-retirement sample continues the audible Mic edge');
  assert.equal(gap.readInt16LE((fadeSamples - 1) * 2), 0, 'the retired Mic contribution reaches silence inside 2 ms');
  assert.equal(gap.readInt16LE(fadeSamples * 2), 0, 'no retired Mic PCM survives the bounded taper');

  const resumed = drainOne(session, 80);
  assert.equal(resumed.readInt16LE(0), 0, 'replacement Mic PCM enters from silence');
  assert.equal(resumed.readInt16LE((fadeSamples - 1) * 2), amplitude, 'replacement Mic reaches full level inside 2 ms');
});

test('bind-time Backing retirement de-clicks both sides without retaining retired PCM', () => {
  const session = makeTransitionSession();
  const chunk = Math.round(RATE * 0.02);
  const fadeSamples = Math.round(RATE * 0.002);
  const amplitude = 12_000;

  session.setBackingExpected(true);
  session.start(0);
  session.ingestBacking(frame(21, 0, chunk, amplitude), RATE, 20);

  const before = drainOne(session, 40);
  assert.equal(before.readInt16LE((chunk - 1) * 2), amplitude);

  session.retireBackingCapture();
  assert.equal(session.readBacking(0, 1)[0], 0, 'retired Backing PCM still disappears synchronously at bind time');

  const replacement = session.ingestBacking(frame(22, 0, chunk, amplitude), RATE, 60);
  assert.equal(replacement.captureRestarted, false, 'bind-time retirement still owns the Backing restart signal');

  const gap = drainOne(session, 60);
  assert.equal(gap.readInt16LE(0), amplitude, 'the first post-retirement sample continues the audible Backing edge');
  assert.equal(gap.readInt16LE((fadeSamples - 1) * 2), 0, 'the retired Backing contribution reaches silence inside 2 ms');
  assert.equal(gap.readInt16LE(fadeSamples * 2), 0, 'no retired Backing PCM survives the bounded taper');

  const resumed = drainOne(session, 80);
  assert.equal(resumed.readInt16LE(0), 0, 'replacement Backing PCM enters from silence');
  assert.equal(resumed.readInt16LE((fadeSamples - 1) * 2), amplitude, 'replacement Backing reaches full level inside 2 ms');
});
