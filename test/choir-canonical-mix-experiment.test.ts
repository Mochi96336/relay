import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  CanonicalChoirMixExperiment, type CanonicalChoirSingerId,
} from '../src/choir-canonical-mix-experiment.js';

const RATE = 48_000;
const FRAME = 960;
const A: CanonicalChoirSingerId = {
  participantId: 'singer-a', songEpoch: 7,
  backingGeneration: 9, mediaEpoch: 11,
};
const B: CanonicalChoirSingerId = {
  participantId: 'singer-b', songEpoch: 7,
  backingGeneration: 9, mediaEpoch: 21,
};

function room() {
  return new CanonicalChoirMixExperiment({
    sampleRate: RATE, frameMs: 20, prebufferMs: 400,
    retentionMs: 3000, songEpoch: 7, backingGeneration: 9,
  });
}

function pcm(count: number, value: number, first = 0,
  generation = 1) {
  return {
    generation, firstSampleIndex: first,
    pcm: Buffer.from(new Int16Array(count).fill(value).buffer),
  };
}
function samples(array: Int16Array, first = 0, generation = 1) {
  return {
    generation, firstSampleIndex: first,
    pcm: Buffer.from(array.buffer, array.byteOffset, array.byteLength),
  };
}

function peakIndex(input: Int16Array) {
  let best = 0;
  for (let i = 1; i < input.length; i++) {
    if (Math.abs(input[i]) > Math.abs(input[best])) best = i;
  }
  return best;
}

describe('canonical MicTrack N=2 through the production MixBus (no live server)', () => {
  test('two independently signed source events meet on one physical room sample', () => {
    const mix = room();
    assert.equal(mix.addSinger(A), true);
    assert.equal(mix.addSinger(B), true);
    assert.equal(mix.setGainDb(A, 0), true);
    assert.equal(mix.setGainDb(B, 0), true);
    assert.equal(mix.setConfirmedLag(A, 120), true);
    assert.equal(mix.setConfirmedLag(B, -340), true);

    const expectedEvent = 20 * FRAME + 320;
    const signalA = new Int16Array(45_000);
    const signalB = new Int16Array(45_000);
    // Truth is independent of the read plan, in capture-native PCM samples.
    signalA[expectedEvent + 5_760] = 16_000;
    signalB[expectedEvent - 16_320] = 16_000;
    assert.equal(mix.ingestMic(A, samples(signalA), RATE, 45_000), true);
    assert.equal(mix.ingestMic(B, samples(signalB), RATE, 45_000), true);

    const output = new Int16Array(26 * FRAME);
    const perSinger = [];
    for (let i = 0; i < 26; i++) {
      const frame = mix.render(i * FRAME);
      output.set(frame.pcm, i * FRAME);
      if (i === 20) perSinger.push(...frame.singers);
    }
    assert.equal(peakIndex(output), expectedEvent,
      'both independently timestamped true impulses land at the same output position');
    assert.ok(output[expectedEvent] > 10_000,
      'both half-headroom singers contribute audibly to a real MixBus sample');
    assert.equal(perSinger.length, 2);
    assert.equal(perSinger[0].participantId, 'singer-a');
    assert.equal(perSinger[1].participantId, 'singer-b');
    assert.equal(perSinger[0].gapSamples, 0);
    assert.equal(perSinger[1].gapSamples, 0);
    assert.equal(mix.setConfirmedLag(B, 0), false,
      'a live calibration hard jump is not authorized by this test harness');
  });

  test('A capture loss remains A evidence while B sings through the same output', () => {
    const mix = room();
    assert.equal(mix.addSinger(A), true);
    assert.equal(mix.addSinger(B), true);
    mix.setGainDb(A, 0);
    mix.setGainDb(B, 0);
    assert.equal(mix.ingestMic(A, pcm(FRAME * 2, 8_000), RATE, FRAME * 2), true);
    assert.equal(mix.ingestMic(A, pcm(FRAME, 8_000, FRAME * 3), RATE, FRAME * 4), true);
    assert.equal(mix.ingestMic(B, pcm(FRAME * 7, 10_000), RATE, FRAME * 7), true);
    mix.render(0);
    mix.render(FRAME);
    const hole = mix.render(FRAME * 2);
    assert.equal(hole.singers[0].gapSamples, FRAME,
      'pitch-concealed audio is still evidence of actual captured packet loss');
    assert.equal(hole.singers[1].gapSamples, 0);
    assert.equal(hole.singers[1].frontierMissingSamples, 0);
    assert.ok(hole.pcm[FRAME / 2] > 0,
      "healthy B remains audible even while A source chunk is concealed");
    assert.equal(hole.outputClippedSamples, 0);
  });

  test('disconnecting A cannot disable B, promote B, or authorize stale A PCM', () => {
    const mix = room();
    mix.addSinger(A);
    mix.addSinger(B);
    mix.setGainDb(A, 0);
    mix.setGainDb(B, 0);
    mix.ingestMic(A, pcm(FRAME, 15_000), RATE, FRAME);
    mix.ingestMic(B, pcm(FRAME * 8, 13_000), RATE, FRAME * 8);
    assert.equal(mix.disconnect({ ...A, mediaEpoch: 10 }), false);
    assert.equal(mix.disconnect(A), true);
    assert.equal(mix.ingestMic(A, pcm(FRAME, 15_000, FRAME), RATE, FRAME * 2), false);
    assert.equal(mix.ingestMic({ ...B, mediaEpoch: 20 },
      pcm(FRAME, 15_000, FRAME), RATE, FRAME * 2), false);
    const out = [];
    for (let i = 0; i < 6; i++) out.push(mix.render(i * FRAME));
    assert.ok(out[4].pcm[FRAME / 2] > 0, 'B remains audible');
    assert.equal(out[4].singers[1].expected, true);
    assert.equal(out[4].singers[0].expected, false);
    assert.ok(out[4].singers[0].frontierMissingSamples > 0);
    assert.equal(mix.addSinger(A), false, 'no silent identity replacement');
  });

  test('even both hard-limited singers plus loud Robot backing do not hard clip', () => {
    const mix = room();
    mix.addSinger(A);
    mix.addSinger(B);
    // Default MicGain is +24 dB on each track: both will limit.
    mix.ingestMic(A, pcm(FRAME * 4, 32_000), RATE, FRAME * 4);
    mix.ingestMic(B, pcm(FRAME * 4, 32_000), RATE, FRAME * 4);
    mix.ingestBacking(pcm(FRAME * 4, 32_000, 0, 5), RATE, FRAME * 4);
    let clipped = 0;
    let limitedA = 0;
    let limitedB = 0;
    let maximum = 0;
    for (let i = 0; i < 3; i++) {
      const f = mix.render(i * FRAME);
      clipped += f.outputClippedSamples;
      limitedA += f.singers[0].limitedSamples;
      limitedB += f.singers[1].limitedSamples;
      maximum = Math.max(maximum, ...f.pcm);
    }
    assert.equal(clipped, 0, 'two singer ceilings share exactly one bus headroom budget');
    assert.ok(limitedA > 0 && limitedB > 0, 'each singer limiter was exercised');
    assert.ok(maximum > 0 && maximum <= 32767);
  });

  test('room sample clock and source epochs cannot be silently replaced', () => {
    const mix = room();
    assert.equal(mix.addSinger({ ...A, songEpoch: 8 }), false);
    assert.equal(mix.addSinger({ ...A, backingGeneration: 10 }), false);
    assert.equal(mix.addSinger(A), true);
    assert.equal(mix.addSinger(A), false);
    assert.equal(mix.addSinger(B), true);
    assert.equal(mix.addSinger({ ...B, participantId: 'third' }), false);
    assert.equal(mix.ingestMic({ ...A, songEpoch: 8 }, pcm(FRAME, 10_000), RATE, FRAME), false);
    assert.equal(mix.ingestMic({ ...A, mediaEpoch: 12 }, pcm(FRAME, 10_000), RATE, FRAME), false);
    mix.render(0);
    assert.throws(() => mix.render(0), /monotonic and contiguous/);
    assert.throws(() => mix.render(FRAME * 2), /monotonic and contiguous/);
    assert.equal(mix.render(FRAME).roomStartSample, FRAME);
  });
});
