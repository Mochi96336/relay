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
    const bSourceEvent = expectedEvent - 16_320;
    // B becomes audible after structural negative-lag pre-roll. Give the
    // original 2ms SourceOutputEdge enough *real* voiced onset before the
    // transient; a mathematical single-sample impulse as the first nonzero
    // sample is intentionally tapered to zero as an anti-click edge.
    signalB.fill(1_200, bSourceEvent - 180, bSourceEvent);
    signalB[bSourceEvent] = 16_000;
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
    // Compare with an A-only source under IDENTICAL two-slot gain/headroom.
    // This proves B contributes, without treating the bus attenuation as 1.
    const aOnly = room();
    aOnly.addSinger(A); aOnly.addSinger(B);
    aOnly.setGainDb(A, 0); aOnly.setGainDb(B, 0);
    aOnly.setConfirmedLag(A, 120); aOnly.setConfirmedLag(B, -340);
    aOnly.ingestMic(A, samples(signalA), RATE, 45_000);
    aOnly.ingestMic(B, samples(new Int16Array(signalB.length)), RATE, 45_000);
    let aOnlySample = 0;
    for (let i = 0; i < 26; i++) {
      const frame = aOnly.render(i * FRAME);
      if (i === 20) aOnlySample = frame.pcm[320];
    }
    assert.ok(output[expectedEvent] > aOnlySample + 1500,
      `second Mic source contribution: both=${output[expectedEvent]}, A-only=${aOnlySample}, delta=${output[expectedEvent]-aOnlySample}; tracks=${JSON.stringify(perSinger)}`);
    assert.equal(perSinger.length, 2);
    assert.equal(perSinger[0].participantId, 'singer-a');
    assert.equal(perSinger[1].participantId, 'singer-b');
    assert.equal(perSinger[0].gapSamples, 0);
    assert.equal(perSinger[1].gapSamples, 0);
    assert.equal(perSinger[0].readStartSample, 20 * FRAME + 5_760);
    assert.equal(perSinger[1].readStartSample, 20 * FRAME - 16_320);
    assert.ok(perSinger[0].voicePeakAbs > 0.3);
    assert.ok(perSinger[1].voicePeakAbs > 0.3,
      'B produces a real post-edge voice, rather than only a correct read index');
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
    let overshootA = 0;
    let overshootB = 0;
    let maximum = 0;
    for (let i = 0; i < 3; i++) {
      const f = mix.render(i * FRAME);
      clipped += f.outputClippedSamples;
      limitedA += f.singers[0].limitedSamples;
      limitedB += f.singers[1].limitedSamples;
      overshootA += f.singers[0].limiterOvershootSamples;
      overshootB += f.singers[1].limiterOvershootSamples;
      maximum = Math.max(maximum, ...f.pcm);
    }
    assert.equal(clipped, 0, 'two singer ceilings share exactly one bus headroom budget');
    assert.ok(limitedA > 0 && limitedB > 0, 'each singer limiter was exercised');
    assert.ok(overshootA > 0 && overshootB > 0,
      'limiter finite attack must be reported rather than hidden by the output clamp');
    assert.ok(maximum > 0 && maximum <= 32767);
  });

  test('B joins an already singing A without introducing a step in the shared Mic bus', () => {
    const two = room();
    const solo = room();
    for (const mix of [two, solo]) {
      assert.equal(mix.addSinger(A), true);
      assert.equal(mix.setGainDb(A, 0), true);
      assert.equal(mix.ingestMic(A, pcm(FRAME * 10, 6_000), RATE, FRAME * 10), true);
      for (let n = 0; n < 3; n++) mix.render(n * FRAME);
    }
    assert.equal(two.addSinger(B), true);
    assert.equal(two.setGainDb(B, 0), true);
    assert.equal(two.ingestMic(B, pcm(FRAME * 3, 10_000), RATE, FRAME * 6), true);
    const withB = two.render(3 * FRAME).pcm;
    const withoutB = solo.render(3 * FRAME).pcm;
    const firstJoinContribution = withB[0] - withoutB[0];
    const fullJoinContribution = withB[FRAME - 1] - withoutB[FRAME - 1];
    assert.ok(Math.abs(firstJoinContribution) < 100,
      `a new Mic may not enter a running bus at full volume: delta=${firstJoinContribution}`);
    assert.ok(fullJoinContribution > 1000,
      `B should reach an audible contribution by the end of 10ms: delta=${fullJoinContribution}`);
    assert.equal(two.render(4 * FRAME).singers[0].expected, true);
    assert.equal(solo.render(4 * FRAME).singers[0].expected, true);
  });

  test('replacement after ended A capture discards old calibration/clock/evidence and preserves B', () => {
    const mix = room();
    const A2 = { ...A, mediaEpoch: A.mediaEpoch + 10 };
    assert.equal(mix.addSinger(A), true);
    assert.equal(mix.addSinger(B), true);
    mix.setGainDb(A, 0);
    mix.setGainDb(B, 0);
    mix.setConfirmedLag(A, 0);
    mix.ingestMic(A, pcm(FRAME, 12_000), RATE, FRAME);
    mix.ingestMic(B, pcm(FRAME * 9, 9_000), RATE, FRAME * 9);
    assert.equal(mix.disconnect(A), true);
    assert.equal(mix.canRebindDisconnected('singer-a'), false,
      'the old capture still has real audible samples');
    assert.equal(mix.replaceDisconnectedSinger(A2), false);
    for (let n = 0; n < 3; n++) mix.render(n * FRAME);
    assert.equal(mix.canRebindDisconnected('singer-a'), true,
      'old source tail and source-output-edge have actually reached silence');
    assert.equal(mix.replaceDisconnectedSinger({ ...A2, mediaEpoch: A.mediaEpoch }), false,
      'old media epochs are never re-admitted');
    assert.equal(mix.replaceDisconnectedSinger(A2), true);
    assert.equal(mix.mediaEpochFor('singer-a'), A2.mediaEpoch);
    assert.equal(mix.ingestMic(A, pcm(FRAME, 18_000), RATE, FRAME * 4), false);
    assert.equal(mix.ingestMic(A2, pcm(FRAME, 10_000), RATE, FRAME * 4), true);
    const pending = mix.render(FRAME * 3);
    assert.equal(pending.singers[0].awaitingCalibration, true);
    assert.equal(pending.singers[0].voicePeakAbs, 0);
    assert.equal(pending.singers[1].awaitingCalibration, false);
    const valid = {
      source: 'content' as const,
      advanceMs: 0,
      sampleResidualMs: null, bootResidualMs: null,
      sampleCandidateMs: null, bootCandidateMs: null,
    };
    assert.equal(mix.acceptReboundAlignment(A, valid), false,
      'old media epoch cannot reactivate even a confirmed Content result');
    assert.equal(mix.acceptReboundAlignment(A2, {
      ...valid, source: 'content-held',
    }), false, 'held Content cannot unmute a new capture');
    assert.equal(mix.acceptReboundAlignment(A2, {
      ...valid, source: 'unavailable', advanceMs: null,
    }), false, 'missing fallback cannot unmute a new capture');
    assert.equal(mix.acceptReboundAlignment(A2, valid), true);
    assert.equal(mix.acceptReboundAlignment(A2, valid), false,
      'replaying an old decision cannot change an already audible source');
    assert.equal(mix.ingestMic(A2, pcm(FRAME, 10_000, FRAME), RATE, FRAME * 5),
      true, 'confirmed new source can contribute its next real capture packet');
    const f = mix.render(FRAME * 4);
    assert.ok(f.singers[0].voicePeakAbs > 0.1,
      'new source actually reaches audible canonical limiter after fresh alignment');
    assert.ok(f.singers[1].voicePeakAbs > 0.1,
      'B stays audible during A capture replacement');
    assert.equal(f.singers[0].awaitingCalibration, false);
    assert.equal(f.singers[0].mediaEpoch, A2.mediaEpoch);
    assert.equal(f.singers[1].mediaEpoch, B.mediaEpoch);
    assert.equal(f.singers[0].latePacketDrops, 0);
    assert.equal(f.singers[1].expected, true);
    assert.ok(f.singers[1].voicePeakAbs > 0);
    assert.equal(mix.setConfirmedLag(A, 0), false, 'stale A calibration rejected');
  });

  test('future-dated, duplicate and stale capture packets never move one singer timeline', () => {
    const mix = room();
    assert.equal(mix.addSinger(A), true);
    assert.equal(mix.addSinger(B), true);
    assert.equal(mix.ingestMic(A, pcm(FRAME, 3_000), RATE, FRAME), true);
    assert.equal(mix.ingestMic(B, pcm(FRAME, 8_000), RATE, FRAME), true);
    assert.equal(mix.ingestMic(A, pcm(FRAME, 3_000), RATE, FRAME), false,
      'duplicate capture interval is not an additional source sample');
    assert.equal(mix.ingestMic(A, pcm(FRAME, 3_000, RATE * 8), RATE, 2 * FRAME), false,
      'wildly future-dated PCM must not poison read-head retention');
    assert.equal(mix.ingestMic(A, pcm(FRAME * 105, 3_000, FRAME), RATE, FRAME), false,
      'a single pathological PCM packet must not consume seconds of CPU');
    assert.equal(mix.ingestMic(A, pcm(FRAME, 3_000, 0, 2), RATE, FRAME * 3), true,
      'the newer capture generation may still legitimately restart');
    assert.equal(mix.ingestMic(A, pcm(FRAME, 3_000, FRAME, 1), RATE, FRAME * 4), false,
      'an old generation cannot be reinterpreted as a fresh restart');
    assert.equal(mix.ingestMic(B, pcm(FRAME, 8_000, FRAME), RATE, FRAME * 2), true,
      'B source continues independently of A packet fencing');
    const frame = mix.render(0);
    assert.equal(frame.singers[0].gapSamples, 0);
    assert.equal(frame.singers[1].gapSamples, 0);
  });

  test('a large absolute native capture origin is not confused with a future attack', () => {
    const mix = room();
    assert.equal(mix.addSinger(A), true);
    const start = RATE * 3600;
    assert.equal(mix.ingestMic(A, pcm(FRAME, 7_000, start), RATE, FRAME), true);
    assert.equal(mix.ingestMic(A, pcm(FRAME, 7_000, start + FRAME), RATE, FRAME * 2), true,
      'the native source index can be large even while the room clock is young');
    assert.equal(mix.render(0).singers[0].gapSamples, 0);
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
