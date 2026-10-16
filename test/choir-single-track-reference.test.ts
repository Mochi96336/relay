import assert from 'node:assert/strict';
import test from 'node:test';

import { AudioSession } from '../src/audio-session.js';
import { CanonicalChoirMixExperiment } from '../src/choir-canonical-mix-experiment.js';

/**
 * Coordinate comparison using the CURRENT canonical MicTrack-derived Choir
 * mix. This is not a byte-exact N=1 check; the separate Golden PCM CI owns
 * that invariant. It verifies the real one-singer event is at the same
 * room sample as the AudioSession reference.
 */
const RATE = 48_000;
const FRAME = 960;
const SINGER = {
  participantId: 'single-singer',
  songEpoch: 1,
  backingGeneration: 1,
  mediaEpoch: 1,
};

function peakIndex(samples: Int16Array): number {
  let index = 0;
  for (let i = 1; i < samples.length; i++) {
    if (Math.abs(samples[i]) > Math.abs(samples[index])) index = i;
  }
  return index;
}

test('N=1 room event coordinate matches the existing AudioSession reference', () => {
  const signal = new Int16Array(FRAME * 12);
  const trueEvent = FRAME * 5 + 420;
  signal[trueEvent] = 16_000;

  const legacy = new AudioSession({
    sampleRate: RATE, frameMs: 20, prebufferMs: 0,
    backingGain: .65, retentionMs: 4_000,
  });
  legacy.setMicGainDb(0);
  legacy.start(0);
  legacy.setMicExpected(true);
  legacy.ingestMic({
    generation: 1, firstSampleIndex: 0,
    pcm: Buffer.from(signal.buffer, signal.byteOffset, signal.byteLength),
  }, RATE, 0);

  const oldFrames: Buffer[] = [];
  while (legacy.drain((buffer) => oldFrames.push(buffer), 240, 5) > 0) { /* emit */ }
  const oldPcm = Buffer.concat(oldFrames);
  const oldSamples = new Int16Array(
    oldPcm.buffer, oldPcm.byteOffset, oldPcm.byteLength / 2,
  );
  assert.equal(oldFrames.length, 13, 'AudioSession includes the frame due at 240ms');
  assert.ok(Math.abs(oldSamples[trueEvent]) > 200);
  const oldPeak = peakIndex(oldSamples);

  const choir = new CanonicalChoirMixExperiment({
    sampleRate: RATE, frameMs: 20, prebufferMs: 0,
    retentionMs: 4_000, songEpoch: SINGER.songEpoch,
    backingGeneration: SINGER.backingGeneration,
  });
  assert.equal(choir.addSinger(SINGER), true);
  assert.equal(choir.setConfirmedLag(SINGER, 0), true);
  assert.equal(choir.ingestMic(SINGER, {
    generation: 1, firstSampleIndex: 0,
    pcm: Buffer.from(signal.buffer, signal.byteOffset, signal.byteLength),
  }, RATE, 0), true);
  const emitted = new Int16Array(FRAME * 12);
  for (let i = 0; i < 12; i++) {
    const frame = choir.render(i * FRAME);
    emitted.set(frame.pcm, i * FRAME);
  }
  const choirPeak = peakIndex(emitted);
  assert.ok(Math.abs(emitted[trueEvent]) > 200);
  assert.ok(Math.abs(oldPeak - trueEvent) <= 1, `legacy source index ${oldPeak}`);
  assert.ok(Math.abs(choirPeak - trueEvent) <= 1, `choir source index ${choirPeak}`);
  assert.ok(Math.abs(choirPeak - oldPeak) <= 1,
    `N=1 reference event mismatch: legacy ${oldPeak}, choir ${choirPeak}`);
});
