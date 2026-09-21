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
    47_999,
    'the continuation first supplies the deferred target sample at its true session position',
  );
  const deferredSourcePosition = (479 * 44_100) / RATE;
  const deferredFraction = deferredSourcePosition - Math.floor(deferredSourcePosition);
  const expectedDeferred = Math.round(333 + (444 - 333) * deferredFraction);
  assert.equal(
    session.readBacking(47_999, 1)[0],
    expectedDeferred,
    'the deferred boundary sample interpolates the old tail into the new packet instead of clamping or becoming a hole',
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
