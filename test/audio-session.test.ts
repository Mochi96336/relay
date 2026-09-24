import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { AudioSession } from '../src/audio-session.js';
import type { PcmFrame } from '../src/pcm-frame.js';

const RATE = 48_000;

function makeSession(overrides: Partial<ConstructorParameters<typeof AudioSession>[0]> = {}) {
  const session = new AudioSession({
    sampleRate: RATE,
    frameMs: 20,
    prebufferMs: 0,
    backingGain: 1,
    retentionMs: 5_000,
    ...overrides,
  });
  session.setMicGainDb(0);
  return session;
}

function frame(firstSampleIndex: number, pcm: Buffer, generation = 1): PcmFrame {
  return { generation, firstSampleIndex, pcm };
}

function unheaderedFrame(pcm: Buffer): PcmFrame {
  return { generation: null, firstSampleIndex: null, pcm };
}

function pcmOf(samples: number[]) {
  const buffer = Buffer.alloc(samples.length * 2);
  samples.forEach((value, i) => buffer.writeInt16LE(value, i * 2));
  return buffer;
}

/** `ms` of silence with a constant level over the final millisecond. */
function markedAt(totalMs: number, markMs: number, level: number) {
  const samples = new Array(Math.round((RATE * totalMs) / 1000)).fill(0);
  const start = Math.round((RATE * markMs) / 1000);
  for (let i = 0; i < Math.round(RATE / 1000); i += 1) samples[start + i] = level;
  return pcmOf(samples);
}

function drainAll(session: AudioSession, untilMs: number) {
  const frames: Buffer[] = [];
  // maxFrames mirrors the server's per-tick cap, so drain repeatedly.
  while (session.drain((f) => frames.push(f), untilMs) > 0) { /* keep pulling */ }
  return Buffer.concat(frames);
}

function peakSampleIndex(mixed: Buffer) {
  let best = -1;
  let bestValue = 0;
  for (let i = 0; i < mixed.byteLength / 2; i += 1) {
    const value = Math.abs(mixed.readInt16LE(i * 2));
    if (value > bestValue) {
      bestValue = value;
      best = i;
    }
  }
  return { index: best, value: bestValue };
}

describe('AudioSession timelines', () => {
  test('places frames by their stated index, not their arrival order', () => {
    const session = makeSession();
    session.start(0);

    session.ingestMic(frame(0, pcmOf([1, 2, 3, 4])), RATE, 0);
    session.ingestMic(frame(4, pcmOf([5, 6])), RATE, 0);

    assert.deepEqual([...session.readMic(0, 6)], [1, 2, 3, 4, 5, 6]);
    assert.equal(session.health().micGapMs, 0);
  });

  test('never relocates late overlapping audio to the write frontier', () => {
    const session = makeSession();
    session.start(0);

    session.ingestMic(frame(0, pcmOf([1, 2, 3, 4])), RATE, 0);
    const late = session.ingestMic(frame(2, pcmOf([9, 9])), RATE, 0);
    assert.equal(late.samples.length, 0, 'a fully late frame is discarded, not moved later');
    assert.deepEqual([...session.readMic(0, 4)], [1, 2, 3, 4]);

    session.ingestMic(frame(3, pcmOf([7, 8, 9])), RATE, 0);
    assert.deepEqual(
      [...session.readMic(0, 6)],
      [1, 2, 3, 4, 8, 9],
      'only the non-overlapping tail keeps its original sample positions',
    );
  });

  // The mixer reads the song at the read head, so a second of history is all
  // it ever wanted - but a probe calibration reads back across its whole
  // search window, and cannot do so until enough audio has arrived to cover
  // it. Trimming to the mixer's need alone silently handed that reader zeros.
  test('keeps captured song history for readers further back than the mixer', () => {
    const session = makeSession({ backingRetentionMs: 4_000, prebufferMs: 0 });
    session.start(0);

    // A marker three seconds back, then enough audio to carry the read head
    // well past it and trigger the trim.
    const marker = pcmOf(new Array(RATE).fill(9_000));
    session.ingestBacking(frame(0, marker), RATE, 0);
    session.ingestBacking(frame(RATE, pcmOf(new Array(RATE * 4).fill(0))), RATE, 0);
    session.ingestMic(frame(0, pcmOf(new Array(RATE * 5).fill(0))), RATE, 0);
    drainAll(session, 4_000);

    const recovered = session.readBacking(0, RATE);
    assert.ok(
      recovered.some((sample) => sample !== 0),
      'the song under the read head was discarded before a later reader could look at it',
    );
  });

  test('conceals a Mic packet hole audibly while reporting its full evidence', () => {
    const session = makeSession();
    session.start(0);

    const chunk = Math.round(RATE * 0.02);
    const amplitude = 12_000;
    session.ingestMic(frame(0, pcmOf(new Array(chunk).fill(amplitude))), RATE, 0);
    session.ingestMic(
      frame(chunk * 2, pcmOf(new Array(chunk).fill(amplitude))),
      RATE,
      0,
    );

    const read = session.readMic(0, chunk * 3);
    const joinSamples = Math.round(RATE * 0.004);
    const gapStart = chunk;
    const gapEnd = chunk * 2;

    assert.equal(read[gapStart], amplitude, 'the hole continues the voice instead of dropping to silence');
    assert.ok(read[gapEnd - 1] > amplitude / 2, 'a 20 ms hole is still audible at its end');
    let maxStep = 0;
    for (let index = 1; index < read.length; index += 1) {
      maxStep = Math.max(maxStep, Math.abs(read[index] - read[index - 1]));
    }
    assert.ok(maxStep <= 200, `concealment joins both edges without a step: ${maxStep}`);
    assert.equal(
      read[gapEnd + joinSamples],
      amplitude,
      'audio after the bounded join returns to exactly what was received',
    );

    assert.equal(session.health().micGapMs, 20);
    assert.deepEqual(session.readMicEvidence(0, chunk * 3), {
      gapSamples: chunk,
      frontierMissingSamples: 0,
      unheaderedSamples: 0,
    }, 'concealment must not reduce or hide packet-loss evidence');
  });

  test('keeps the plain de-click taper when the capture has too little history to conceal', () => {
    const session = makeSession();
    session.start(0);

    const chunk = Math.round(RATE * 0.02);
    const amplitude = 12_000;
    // 1 ms of real audio cannot hold a pitch period plus its correlation window.
    session.ingestMic(frame(0, pcmOf(new Array(48).fill(amplitude))), RATE, 0);
    session.ingestMic(frame(48 + chunk, pcmOf(new Array(chunk).fill(amplitude))), RATE, 0);

    const read = session.readMic(0, 48 + chunk * 2);
    assert.equal(read[48], 0, 'without concealment the hole is literal silence');
    assert.equal(read[48 + chunk - 1], 0);
    assert.equal(read[48 + chunk], 0, 'and the recovered edge fades in from silence');
    assert.deepEqual(session.readMicEvidence(0, 48 + chunk * 2), {
      gapSamples: chunk,
      frontierMissingSamples: 0,
      unheaderedSamples: 0,
    });
  });

  test('de-clicks Backing packet-hole edges without concealing the missing interval', () => {
    const session = makeSession();
    session.start(0);

    const chunk = Math.round(RATE * 0.02);
    const amplitude = 12_000;
    session.ingestBacking(frame(0, pcmOf(new Array(chunk).fill(amplitude))), RATE, 0);
    session.ingestBacking(
      frame(chunk * 2, pcmOf(new Array(chunk).fill(amplitude))),
      RATE,
      40,
    );

    const read = session.readBacking(0, chunk * 3);
    const fadeSamples = Math.round(RATE * 0.002);
    const gapStart = chunk;
    const gapEnd = chunk * 2;

    assert.equal(read[gapStart], 0, 'the missing Backing packet still begins as literal silence');
    assert.equal(read[gapEnd - 1], 0, 'the Backing hole remains silence through its final sample');
    assert.equal(read[gapEnd], 0, 'the first recovered song sample starts at silence instead of clicking in');

    assert.ok(
      Math.abs(read[gapStart - 2] - read[gapStart - 1]) <= 200,
      'Backing fade-out approaches the hole without a full-scale one-sample step',
    );
    assert.ok(
      Math.abs(read[gapEnd + 1] - read[gapEnd]) <= 200,
      'Backing fade-in leaves the hole without a full-scale one-sample step',
    );
    assert.equal(
      read[gapStart - fadeSamples - 1],
      amplitude,
      'song audio before the bounded de-click window stays untouched',
    );
    assert.equal(
      read[gapEnd + fadeSamples],
      amplitude,
      'song audio after the bounded de-click window returns to the original level',
    );

    assert.equal(session.health().backingGapMs, 20);
    assert.deepEqual(session.readBackingEvidence(0, chunk * 3), {
      gapSamples: chunk,
      frontierMissingSamples: 0,
      unheaderedSamples: 0,
    }, 'Backing de-clicking must not reduce or hide packet-loss evidence');
  });

  test('does not fade a continuous Backing packet boundary', () => {
    const session = makeSession();
    session.start(0);

    const chunk = Math.round(RATE * 0.02);
    session.ingestBacking(frame(0, pcmOf(new Array(chunk).fill(7_000))), RATE, 0);
    session.ingestBacking(frame(chunk, pcmOf(new Array(chunk).fill(11_000))), RATE, 20);

    const read = session.readBacking(0, chunk * 2);
    assert.equal(read[chunk - 1], 7_000);
    assert.equal(read[chunk], 11_000);
    assert.equal(session.health().backingGapMs, 0);
  });

  test('does not fade a continuous Mic packet boundary', () => {
    const session = makeSession();
    session.start(0);

    const chunk = Math.round(RATE * 0.02);
    session.ingestMic(frame(0, pcmOf(new Array(chunk).fill(7_000))), RATE, 0);
    session.ingestMic(frame(chunk, pcmOf(new Array(chunk).fill(11_000))), RATE, 0);

    const read = session.readMic(0, chunk * 2);
    assert.equal(read[chunk - 1], 7_000);
    assert.equal(read[chunk], 11_000);
    assert.equal(session.health().micGapMs, 0);
  });

  test('a skipped frame leaves a hole of exactly the right length', () => {
    const session = makeSession();
    session.start(0);

    const chunk = Math.round(RATE * 0.02);
    session.ingestMic(frame(0, pcmOf(new Array(chunk).fill(1000))), RATE, 0);
    // Frame at index `chunk` was captured but never sent.
    session.ingestMic(frame(chunk * 2, pcmOf(new Array(chunk).fill(2000))), RATE, 0);

    assert.equal(session.health().micGapMs, 20);

    const read = session.readMic(0, chunk * 3);
    assert.equal(read[0], 1000);
    assert.equal(read[chunk], 1000, 'the hole is concealed from the audio before it, not pulled forward');
    assert.equal(read[chunk * 2 + Math.round(RATE * 0.004)], 2000, 'later audio keeps its original position');

    assert.deepEqual(session.readMicEvidence(0, chunk * 3), {
      gapSamples: chunk,
      frontierMissingSamples: 0,
      unheaderedSamples: 0,
    }, 'range evidence distinguishes a hole behind the frontier from complete PCM');
    assert.deepEqual(session.readMicEvidence(0, chunk * 4), {
      gapSamples: chunk,
      frontierMissingSamples: chunk,
      unheaderedSamples: 0,
    }, 'range evidence separately reports audio requested beyond the frontier');
  });

  test('a new capture session re-anchors to the session clock', () => {
    const session = makeSession();
    session.start(0);

    session.ingestMic(frame(0, pcmOf([1, 1, 1, 1]), 1), RATE, 0);
    assert.equal(session.micGeneration, 1);

    // A different capture restarting its own index at zero must not overwrite
    // the beginning of the timeline.
    session.ingestMic(frame(0, pcmOf([2, 2, 2, 2]), 2), RATE, 1_000);
    assert.equal(session.micGeneration, 2);
    assert.equal(session.readMic(0, 1)[0], 1, 'the earlier session keeps its place');
    assert.equal(session.readMic(RATE - 4, 1)[0], 2, 'the new one lands at the clock');
  });

  test('flags a stream that arrives without a header', () => {
    const session = makeSession();
    session.start(0);

    assert.equal(session.health().unheadered, false);
    session.ingestMic(unheaderedFrame(pcmOf([1, 2])), RATE, 0);
    assert.equal(session.health().unheadered, true);
    assert.deepEqual([...session.readMic(0, 2)], [1, 2], 'the audio is still used');
  });

  test('does not carry an unheadered warning into a new session', () => {
    const session = makeSession();
    session.start(0);
    session.ingestMic(unheaderedFrame(pcmOf([1, 2])), RATE, 0);
    assert.equal(session.health().unheadered, true);

    session.stop();
    session.start(1_000);

    assert.equal(session.health().unheadered, false);
  });

  test('deferred 44.1 kHz tail does not shift a fresh capture clock by one sample', () => {
    const sourceRate = 44_100;
    const chunkSamples = 882;
    const session = makeSession();
    session.start(0);

    session.ingestMic(
      frame(0, pcmOf(new Array(chunkSamples).fill(500))),
      sourceRate,
      1_000,
    );

    const nominalTargetSamples = 960;
    const expectedStart = RATE - nominalTargetSamples;
    assert.equal(
      session.readMic(expectedStart, 1)[0],
      500,
      'the 20 ms source interval still anchors 20 ms before the arrival clock',
    );
    assert.equal(session.readMic(expectedStart - 1, 1)[0], 0);
    assert.equal(
      session.micTotalSamples,
      RATE - 1,
      'only the future-dependent tail sample is deferred; the capture origin does not move',
    );
  });

  test('44.1 kHz resampling is independent of 20 ms capture chunk boundaries', () => {
    const sourceRate = 44_100;
    const chunkSamples = 882; // exactly 20 ms
    const sourceSamples = chunkSamples * 2;
    const frequencyHz = 8_000;
    const input = Array.from({ length: sourceSamples }, (_, index) => (
      Math.round(10_000 * Math.sin((2 * Math.PI * frequencyHz * index) / sourceRate))
    ));

    const whole = makeSession();
    whole.start(0);
    whole.ingestMic(frame(0, pcmOf(input)), sourceRate, 0);

    const chunked = makeSession();
    chunked.start(0);
    chunked.ingestMic(frame(0, pcmOf(input.slice(0, chunkSamples))), sourceRate, 0);
    chunked.ingestMic(
      frame(chunkSamples, pcmOf(input.slice(chunkSamples))),
      sourceRate,
      20,
    );

    assert.equal(
      chunked.micTotalSamples,
      whole.micTotalSamples,
      'capture chunking must not change the resampled frontier',
    );
    const count = whole.micTotalSamples;
    const wholeOutput = whole.readMic(0, count);
    const chunkedOutput = chunked.readMic(0, count);

    let maximumDifference = 0;
    for (let index = 0; index < count; index += 1) {
      maximumDifference = Math.max(
        maximumDifference,
        Math.abs(wholeOutput[index] - chunkedOutput[index]),
      );
    }

    assert.ok(
      maximumDifference <= 1,
      `20 ms capture chunking changed the resampled waveform by ${maximumDifference} PCM counts`,
    );
    assert.ok(
      Math.abs(chunkedOutput[959]) > 100,
      'the deferred boundary sample is real interpolated audio, not a padded zero',
    );
    assert.equal(chunked.health().micGapMs, 0);
  });

  test('44.1 kHz streaming resampling never interpolates across a real source gap', () => {
    const sourceRate = 44_100;
    const chunkSamples = 882;
    const first = new Array(chunkSamples).fill(8_000);
    const recovered = new Array(chunkSamples).fill(8_000);

    const session = makeSession();
    session.start(0);
    session.ingestMic(frame(0, pcmOf(first)), sourceRate, 0);
    // One complete 20 ms source chunk was never delivered.
    session.ingestMic(
      frame(chunkSamples * 2, pcmOf(recovered)),
      sourceRate,
      40,
    );

    assert.equal(session.health().micGapMs, 20);
    assert.equal(
      session.readMicEvidence(959, 1).gapSamples,
      1,
      'a target sample waiting for source look-ahead becomes part of the gap, not interpolation across it',
    );
  });

  test('44.1 kHz resampling is independent of WebTransport packet splits', () => {
    const sourceRate = 44_100;
    const sourceSamples = 882; // exactly 20 ms
    const frequencyHz = 8_000;
    const input = Array.from({ length: sourceSamples }, (_, index) => (
      Math.round(10_000 * Math.sin((2 * Math.PI * frequencyHz * index) / sourceRate))
    ));

    const whole = makeSession();
    whole.start(0);
    whole.ingestMic(frame(0, pcmOf(input)), sourceRate, 0);
    const wholeOutput = whole.readMic(0, 960);

    const split = makeSession();
    split.start(0);
    // A 1000-byte WebTransport media budget leaves 976 PCM bytes after the
    // 24-byte packet envelope: 488 Int16 samples, then the remaining 394.
    split.ingestMic(frame(0, pcmOf(input.slice(0, 488))), sourceRate, 0);
    split.ingestMic(frame(488, pcmOf(input.slice(488))), sourceRate, 0);
    const splitOutput = split.readMic(0, 960);

    let maximumDifference = 0;
    for (let index = 0; index < wholeOutput.length; index += 1) {
      maximumDifference = Math.max(
        maximumDifference,
        Math.abs(wholeOutput[index] - splitOutput[index]),
      );
    }

    assert.ok(
      maximumDifference <= 1,
      `transport packetization changed the resampled waveform by ${maximumDifference} PCM counts`,
    );
    assert.equal(split.health().micGapMs, 0, 'packetization must not invent a timeline gap');
  });

  test('resamples a source running at a different rate', () => {
    const session = makeSession();
    session.start(0);

    session.ingestMic(frame(0, pcmOf(new Array(24_000).fill(500)), 1), 24_000, 0);
    assert.equal(session.readMic(0, 1)[0], 500);
    // Half a second at 24 kHz becomes half a second at 48 kHz.
    assert.equal(session.readMic(47_000, 1)[0], 500);
    assert.equal(session.readMic(49_000, 1)[0], 0);
  });
});

describe('AudioSession alignment', () => {
  test('falls back to the network estimate until a calibration lands', () => {
    // Roomy enough that nothing here is clamped; affordability is its own test.
    const session = makeSession({ prebufferMs: 2_000 });
    session.setAlignment({ networkCompensationMs: 80 });
    assert.equal(session.appliedMicAdvanceMs, 80);

    session.setAlignment({ calibratedMicLagMs: 300 });
    assert.equal(session.appliedMicAdvanceMs, 300, 'a measurement beats the estimate');

    session.setAlignment({ fineTuneMs: 25 });
    assert.equal(session.appliedMicAdvanceMs, 275);
  });

  test('will not read further ahead than the prebuffer can pay for', () => {
    const session = makeSession({ prebufferMs: 800, retentionMs: 5_000 });

    session.setAlignment({ calibratedMicLagMs: 1_800 });
    assert.equal(session.requestedMicAdvanceMs, 1_800, 'the measurement is reported as measured');
    assert.equal(session.appliedMicAdvanceMs, 600, 'but only 800 - 200 ms of it is affordable');
  });

  test('will not read further behind than the retained history holds', () => {
    const session = makeSession({ prebufferMs: 800, retentionMs: 1_500 });

    session.setAlignment({ calibratedMicLagMs: -4_000 });
    assert.equal(session.appliedMicAdvanceMs, -1_300);
  });

  test('leaves an affordable advance alone', () => {
    const session = makeSession({ prebufferMs: 800, retentionMs: 1_500 });

    session.setAlignment({ calibratedMicLagMs: -60 });
    assert.equal(session.appliedMicAdvanceMs, -60, 'a negative lag is paid out of history, not prebuffer');
  });

  test('a clamped advance keeps the vocal audible rather than starving it', () => {
    const session = makeSession({ prebufferMs: 800, retentionMs: 5_000 });
    session.setMicExpected(true);
    session.start(0);

    session.ingestBacking(frame(0, markedAt(2_000, 100, 5_000)), RATE, 0);
    session.ingestMic(frame(0, markedAt(2_000, 100, 5_000)), RATE, 0);
    // Far more than the buffer affords. Obeying it would read past the end of
    // the microphone history for every frame.
    session.setAlignment({ calibratedMicLagMs: 10_000 });

    drainAll(session, 1_000);
    assert.equal(session.health().micStarvedFrames, 0, 'clamping is what stops the starvation');
  });

  test('reads the microphone ahead so a delayed vocal lands on the beat', () => {
    // 300 ms of read-ahead has to be affordable, so the prebuffer has to cover
    // it with the safety margin on top.
    const prebufferMs = 600;
    const session = makeSession({ prebufferMs });
    session.setMicExpected(true);
    session.setBackingExpected(true);
    session.start(0);

    // The same event, 300 ms later in the microphone stream than in the song.
    session.ingestBacking(frame(0, markedAt(1_000, 400, 12_000)), RATE, 0);
    session.ingestMic(frame(0, markedAt(1_000, 700, 12_000)), RATE, 0);
    session.setAlignment({ calibratedMicLagMs: 300 });

    const mixed = drainAll(session, 700 + prebufferMs);
    const peak = peakSampleIndex(mixed);
    const peakMs = (peak.index / RATE) * 1000;

    assert.ok(Math.abs(peakMs - 400) < 5, `expected both events at ~400 ms, peak at ${peakMs.toFixed(1)} ms`);
    assert.ok(
      peak.value > 12_000,
      `the two should still sum after deterministic bus headroom, got ${peak.value}`,
    );
  });

  test('a wrong calibration pulls the vocal off the beat', () => {
    const session = makeSession();
    session.start(0);

    session.ingestBacking(frame(0, markedAt(1_000, 400, 12_000)), RATE, 0);
    session.ingestMic(frame(0, markedAt(1_000, 700, 12_000)), RATE, 0);
    session.setAlignment({ calibratedMicLagMs: 0 });

    const mixed = drainAll(session, 900);
    // Song at 400 ms and vocal still at 700 ms: two separate peaks, neither
    // summed. This is what a bogus measurement sounds like.
    assert.equal(peakSampleIndex(mixed).value, 12_000);
  });
});

describe('AudioSession health', () => {
  test('counts starvation only for a source that is meant to be there', () => {
    const session = makeSession();
    session.start(0);
    session.ingestBacking(frame(0, markedAt(1_000, 10, 5_000)), RATE, 0);

    drainAll(session, 500);
    assert.equal(session.health().micStarvedFrames, 0, 'no phone connected is not starvation');

    session.setMicExpected(true);
    drainAll(session, 900);
    assert.ok(session.health().micStarvedFrames > 0, 'a connected phone that stops is');
    assert.ok(session.health().micHeadroomMs < 0);
  });

  test('reports positive headroom while both streams are ahead of the mixer', () => {
    const session = makeSession();
    session.setMicExpected(true);
    session.setBackingExpected(true);
    session.start(0);

    session.ingestBacking(frame(0, markedAt(2_000, 10, 5_000)), RATE, 0);
    session.ingestMic(frame(0, markedAt(2_000, 10, 5_000)), RATE, 0);

    drainAll(session, 500);
    const health = session.health();
    assert.equal(health.micStarvedFrames, 0);
    assert.ok(health.micHeadroomMs > 1_000, `headroom ${health.micHeadroomMs} ms`);
    assert.ok(health.backingHeadroomMs > 1_000);
  });

  test('tracks a slower backing device clock without consuming the live buffer', () => {
    const session = makeSession({ prebufferMs: 100 });
    session.setBackingExpected(true);
    session.start(0);

    const sourceFrame = pcmOf(new Array(960).fill(1_000));
    // 20.02 ms per 20 ms of samples is a deliberately large 1,000 ppm clock
    // mismatch. Without correction it consumes this whole buffer in 100 s.
    for (let index = 0; index < 6_000; index += 1) {
      const nowMs = (index + 1) * 20.02;
      session.ingestBacking(frame(index * 960, sourceFrame), RATE, nowMs, true);
      while (session.drain(() => {}, nowMs) > 0) { /* drain due frames */ }
    }

    const health = session.health();
    assert.equal(health.backingStarvedFrames, 0);
    assert.equal(health.backingGapMs, 0, 'clock trimming is not a transport gap');
    assert.ok(health.backingHeadroomMs > 50, `headroom ${health.backingHeadroomMs} ms`);
    assert.ok(health.backingClockCorrectionSamples > 0, 'the slower source must be stretched');
  });

  test('backing clock correction stretches one frame instead of duplicating its tail sample', () => {
    const session = makeSession({ prebufferMs: 100 });
    session.setBackingExpected(true);
    session.start(0);

    const frequencyHz = 997;
    const amplitude = 12_000;
    let corrected: ReturnType<typeof session.ingestBacking> | null = null;
    let correctedInput: number[] | null = null;

    for (let frameIndex = 0; frameIndex < 6_000 && corrected === null; frameIndex += 1) {
      const firstSourceSample = frameIndex * 960;
      const input = Array.from({ length: 960 }, (_, offset) => (
        Math.round(
          amplitude
          * Math.sin((2 * Math.PI * frequencyHz * (firstSourceSample + offset)) / RATE)
        )
      ));
      const before = session.health().backingClockCorrectionSamples;
      const result = session.ingestBacking(
        frame(firstSourceSample, pcmOf(input)),
        RATE,
        (frameIndex + 1) * 20.02,
        true,
      );
      while (session.drain(() => {}, (frameIndex + 1) * 20.02) > 0) { /* drain due frames */ }

      if (session.health().backingClockCorrectionSamples > before) {
        corrected = result;
        correctedInput = input;
      }
    }

    assert.ok(corrected, 'test clock mismatch must eventually request a +1 sample correction');
    assert.ok(correctedInput);
    assert.equal(corrected.samples.length, 961);
    assert.equal(corrected.samples[0], correctedInput[0], 'stretch preserves the frame start');
    assert.equal(
      corrected.samples[corrected.samples.length - 1],
      correctedInput[correctedInput.length - 1],
      'stretch preserves the frame end',
    );
    assert.notEqual(
      corrected.samples[corrected.samples.length - 2],
      corrected.samples[corrected.samples.length - 1],
      'the added clock sample is distributed across the frame instead of duplicating the tail',
    );
    assert.ok(session.health().backingClockCorrectionSamples > 0);
    assert.equal(session.health().backingGapMs, 0);
  });

  test('backing clock stretch preserves a deferred resampler prefix outside current-frame evidence', () => {
    const sourceRate = 44_100;
    const sourceFrameSamples = 882; // exactly 20 ms
    const frequencyHz = 6_050; // integer 121 cycles per frame, but a sharp frame-boundary slope
    const amplitude = 10_000;

    const session = makeSession({ prebufferMs: 100 });
    session.setBackingExpected(true);
    session.start(0);

    let corrected: ReturnType<typeof session.ingestBacking> | null = null;
    let expectedCurrentFrameFirst = 0;

    for (let frameIndex = 0; frameIndex < 500 && corrected === null; frameIndex += 1) {
      const firstSourceSample = frameIndex * sourceFrameSamples;
      const input = Array.from({ length: sourceFrameSamples }, (_, offset) => (
        Math.round(
          amplitude
          * Math.sin((2 * Math.PI * frequencyHz * (firstSourceSample + offset)) / sourceRate)
        )
      ));
      const before = session.health().backingClockCorrectionSamples;
      const nowMs = (frameIndex + 1) * 21; // intentionally large test-only clock mismatch
      const result = session.ingestBacking(
        frame(firstSourceSample, pcmOf(input)),
        sourceRate,
        nowMs,
        true,
      );
      while (session.drain(() => {}, nowMs) > 0) { /* drain due frames */ }

      if (session.health().backingClockCorrectionSamples > before) {
        corrected = result;
        expectedCurrentFrameFirst = input[0];
      }
    }

    assert.ok(corrected, 'test mismatch must trigger a correction');
    assert.equal(
      corrected.samples.length,
      960,
      'frame-scoped return keeps the future-dependent target deferred: 959 current samples plus one clock trim',
    );
    assert.ok(
      Math.abs(corrected.samples[0] - expectedCurrentFrameFirst) <= 1,
      'the previous frame deferred interpolation prefix must not be stretched into current-frame evidence',
    );
    assert.equal(session.health().backingGapMs, 0);
  });

  test('Robot clock tracking preserves a real missing backing frame as a gap', () => {
    const session = makeSession({ prebufferMs: 100 });
    session.start(0);
    const sourceFrame = pcmOf(new Array(960).fill(1_000));

    session.ingestBacking(frame(0, sourceFrame), RATE, 20, true);
    session.ingestBacking(frame(1_920, sourceFrame), RATE, 60, true);

    assert.equal(session.health().backingGapMs, 20);
  });

  test('Robot clock tracking leaves deliberately prebuffered backing untouched', () => {
    const session = makeSession({ prebufferMs: 100 });
    session.start(0);
    const sourceFrame = pcmOf(new Array(960).fill(1_000));

    // Calibration and recovery tests may enqueue a complete future window in
    // one burst. Being ahead is legal buffering, not negative clock drift.
    for (let index = 0; index < 300; index += 1) {
      session.ingestBacking(frame(index * 960, sourceFrame), RATE, 20, true);
    }

    assert.equal(session.health().backingClockCorrectionSamples, 0);
    assert.equal(session.health().backingGapMs, 0);
  });
});

describe('AudioSession microphone limiter', () => {
  /** A 220 Hz tone with a 20 ms onset, which is how a voice actually starts. */
  function sung(seconds: number, amplitude: number) {
    const total = Math.round(RATE * seconds);
    const onset = Math.round(RATE * 0.02);
    const samples = new Array(total);
    for (let i = 0; i < total; i += 1) {
      const envelope = Math.min(1, i / onset);
      samples[i] = Math.round(amplitude * envelope * Math.sin((2 * Math.PI * 220 * i) / RATE));
    }
    return pcmOf(samples);
  }

  function mixHot(micGainDb: number) {
    const session = makeSession();
    session.setMicGainDb(micGainDb);
    session.start(0);
    session.ingestMic(frame(0, sung(1, 3_200)), RATE, 0);
    return { session, mixed: drainAll(session, 500) };
  }

  function rmsDbfs(mixed: Buffer) {
    const total = mixed.byteLength / 2;
    let sum = 0;
    for (let i = 0; i < total; i += 1) {
      const value = mixed.readInt16LE(i * 2) / 32768;
      sum += value * value;
    }
    return 20 * Math.log10(Math.sqrt(sum / total));
  }

  test('a microphone driven well past full scale never reaches the clamp', () => {
    // +36 dB on a -20 dBFS voice asks for 10 dB more than there is room for.
    const { session, mixed } = mixHot(36);

    assert.equal(session.health().clippedSamples, 0, 'the limiter, not the clamp, must be what holds it');
    assert.ok(session.health().limitedSamples > 0, 'and it must say it was working');
    assert.ok(peakSampleIndex(mixed).value < 32_767, 'nothing is left sitting on the rail');
  });

  test('the output level stops depending on where the gain knob is', () => {
    // The point of the limiter: above the threshold, more gain buys more
    // limiting rather than more distortion, so the knob stops being critical.
    const quiet = rmsDbfs(mixHot(24).mixed);
    const loud = rmsDbfs(mixHot(36).mixed);

    assert.ok(
      Math.abs(loud - quiet) < 1,
      `12 dB of gain should not move the output: ${quiet.toFixed(2)} vs ${loud.toFixed(2)} dBFS`,
    );
  });

  test('meters the raw microphone, not what the gain made of it', () => {
    const session = makeSession();
    session.setMicGainDb(36);
    session.start(0);
    // Peaks at 3200/32768, i.e. -20.2 dBFS, before any gain is applied.
    session.ingestMic(frame(0, sung(1, 3_200)), RATE, 0);

    const health = session.health();
    assert.ok(
      Math.abs((health.micPeakDbfs ?? 0) + 20.2) < 0.5,
      `expected the raw -20.2 dBFS peak, got ${health.micPeakDbfs}`,
    );
    assert.ok((health.micRmsDbfs ?? 0) < (health.micPeakDbfs ?? 0), 'RMS sits below peak');
  });

  test('has nothing to report before the phone sends anything', () => {
    const session = makeSession();
    session.start(0);

    assert.equal(session.health().micPeakDbfs, null);
    assert.equal(session.health().micRmsDbfs, null);
  });

  test('ramps a live Mic gain change instead of stepping at the frame boundary', () => {
    const session = makeSession({ backingGain: 1 });
    session.setMicGainDb(0);
    session.start(0);

    const frameSamples = Math.round(RATE * 0.02);
    const amplitude = 2_000;
    session.ingestMic(
      frame(0, pcmOf(new Array(frameSamples * 3).fill(amplitude))),
      RATE,
      0,
    );

    const firstFrames: Buffer[] = [];
    assert.equal(session.drain((mixed) => firstFrames.push(mixed), 0, 1), 1);
    const first = firstFrames[0];
    const before = first.readInt16LE(first.byteLength - 2);

    session.setMicGainDb(12);
    assert.equal(session.micGainDb, 12, 'command authority exposes the new target immediately');

    const secondFrames: Buffer[] = [];
    assert.equal(session.drain((mixed) => secondFrames.push(mixed), 20, 1), 1);
    const second = secondFrames[0];
    const firstAfter = second.readInt16LE(0);
    const lastAfter = second.readInt16LE(second.byteLength - 2);
    const expectedTarget = Math.round(amplitude * (10 ** (12 / 20)));

    assert.ok(
      Math.abs(firstAfter - before) < 50,
      `gain change stepped at the frame boundary: ${before} -> ${firstAfter}`,
    );

    let maximumStep = 0;
    let previous = firstAfter;
    for (let offset = 2; offset < second.byteLength; offset += 2) {
      const current = second.readInt16LE(offset);
      maximumStep = Math.max(maximumStep, Math.abs(current - previous));
      previous = current;
    }
    assert.ok(maximumStep < 50, `gain ramp contained a ${maximumStep}-count sample step`);
    assert.ok(
      Math.abs(lastAfter - expectedTarget) < 30,
      `20 ms ramp did not settle near +12 dB: got ${lastAfter}, expected ${expectedTarget}`,
    );
    assert.equal(session.health().clippedSamples, 0);
    assert.equal(session.health().limitedSamples, 0);
  });

  test('leaves a signal that already fits alone', () => {
    const session = makeSession();
    session.setMicGainDb(0);
    session.start(0);
    session.ingestMic(frame(0, sung(1, 3_200)), RATE, 0);

    drainAll(session, 500);
    assert.equal(session.health().limitedSamples, 0, 'a quiet take must pass through untouched');
    assert.equal(session.health().clippedSamples, 0);
  });

  test('reserves summing headroom before a hot voice and song can reach the clamp', () => {
    const session = makeSession({ backingGain: 1 });
    session.setMicGainDb(36);
    session.setBackingExpected(true);
    // Both, because the reservation is headroom for a sum. This room really
    // does have two sources; declaring only one would be asking for headroom
    // against something that cannot arrive.
    session.setMicExpected(true);
    session.start(0);
    session.ingestMic(frame(0, sung(1, 3_200)), RATE, 0);
    session.ingestBacking(frame(0, pcmOf(new Array(RATE).fill(30_000))), RATE, 0);

    const mixed = drainAll(session, 500);
    assert.equal(
      session.health().clippedSamples,
      0,
      'normal two-source gain staging must not depend on the hard clamp',
    );
    assert.ok(session.health().limitedSamples > 0, 'the microphone limiter still owns vocal peaks');
    assert.ok(peakSampleIndex(mixed).value < 32_767, 'the mixed bus keeps real headroom');
  });

  test('does not attenuate a voice-only room for backing headroom', () => {
    const session = makeSession({ backingGain: 1 });
    session.setMicGainDb(0);
    session.start(0);
    session.ingestMic(frame(0, pcmOf(new Array(RATE).fill(1_000))), RATE, 0);

    const mixed = drainAll(session, 20);
    assert.equal(mixed.readInt16LE(0), 1_000, 'voice-only output stays at unity');
    assert.equal(session.health().clippedSamples, 0);
  });

  /**
   * The symptom this came from: a song playing to a room where nobody had taken
   * the microphone arrived audibly quiet. The reservation is headroom for a sum,
   * and it was being charged to a source that had nothing to sum with.
   */
  test('does not attenuate a song-only room for a voice nobody is singing', () => {
    const session = makeSession({ backingGain: 1 });
    session.setBackingExpected(true);
    session.start(0);
    session.ingestBacking(frame(0, pcmOf(new Array(RATE).fill(20_000))), RATE, 0);

    const mixed = drainAll(session, 20);
    // Within one LSB: the mix scales positives by 32767 and negatives by 32768,
    // so unity costs a quantisation step. The headroom reservation would cost
    // 3.8 dB - about 7,000 counts here - and is what this pins.
    assert.ok(
      Math.abs(mixed.readInt16LE(0) - 20_000) <= 1,
      `song-only output stays at unity, got ${mixed.readInt16LE(0)}`,
    );
    assert.equal(session.health().clippedSamples, 0);
  });

  test('still reserves headroom once a microphone is expected', () => {
    const session = makeSession({ backingGain: 1 });
    session.setBackingExpected(true);
    session.setMicExpected(true);
    session.start(0);
    session.ingestBacking(frame(0, pcmOf(new Array(RATE).fill(20_000))), RATE, 0);

    const mixed = drainAll(session, 20);
    assert.ok(
      mixed.readInt16LE(0) < 20_000,
      'a room that can sum two sources still pays for the headroom',
    );
  });

  /**
   * The song gain and the summing headroom both follow whether a microphone is
   * expected, so taking the mic mid-song moves the song by several dB. Switched
   * in one sample that is a click - a worse fault than the level it corrects.
   */
  test('ducks the song for an arriving voice without a step', () => {
    const session = makeSession({ backingGain: 0.65 });
    session.setBackingExpected(true);
    session.start(0);
    // Three seconds, so the drains below never read past the audio.
    session.ingestBacking(frame(0, pcmOf(new Array(RATE * 3).fill(20_000))), RATE, 0);

    const before = drainAll(session, 100);
    const unducked = before.readInt16LE(0);

    // The room gains a microphone in the middle of the song.
    session.setMicExpected(true);
    const during = drainAll(session, 600);

    // Across the join as well: a hard switch puts its whole step between the
    // last unducked sample and the first ducked one.
    const across = Buffer.concat([before, during]);
    let worstStep = 0;
    for (let i = 1; i < across.length / 2; i += 1) {
      const step = Math.abs(across.readInt16LE(i * 2) - across.readInt16LE((i - 1) * 2));
      if (step > worstStep) worstStep = step;
    }
    assert.ok(
      worstStep <= unducked / 100,
      `the duck must ramp, largest single-sample step was ${worstStep} of ${unducked}`,
    );

    const ducked = during.readInt16LE(during.length - 2);
    assert.ok(ducked < unducked * 0.8, `the song must actually duck, got ${ducked} from ${unducked}`);

    // And it comes back when the microphone leaves, equally smoothly.
    session.setMicExpected(false);
    const after = drainAll(session, 1_200);
    assert.ok(
      after.readInt16LE(after.length - 2) > unducked * 0.95,
      'the song returns to its own level once no voice is expected',
    );
  });

  test('does not carry limiter gain reduction into the next session', () => {
    const session = makeSession();
    session.setMicGainDb(36);
    session.start(0);
    session.ingestMic(frame(0, sung(1, 3_200)), RATE, 0);
    drainAll(session, 500);
    assert.ok(session.health().limitedSamples > 0, 'the first take must leave the limiter active');

    session.stop();
    session.setMicGainDb(0);
    session.start(1_000);
    session.ingestMic(frame(0, pcmOf(new Array(RATE).fill(1_000)), 2), RATE, 1_000);
    const next = drainAll(session, 1_020);

    assert.equal(next.readInt16LE(0), 1_000, 'the next take starts at unity gain');
    assert.equal(session.health().limitedSamples, 0);
  });
});

describe('AudioSession clock', () => {
  test('emits nothing until the prebuffer has elapsed', () => {
    const session = makeSession({ prebufferMs: 500 });
    session.start(0);
    session.ingestBacking(frame(0, markedAt(2_000, 10, 5_000)), RATE, 0);

    assert.equal(session.drain(() => {}, 400), 0);
    assert.ok(session.drain(() => {}, 600) > 0);
  });

  test('emits nothing at all while stopped', () => {
    const session = makeSession();
    session.ingestBacking(frame(0, markedAt(1_000, 10, 5_000)), RATE, 0);
    assert.equal(session.drain(() => {}, 1_000), 0);
  });

  test('caps how much it emits per call so a stall cannot burst without bound', () => {
    const session = makeSession();
    session.start(0);
    session.ingestBacking(frame(0, markedAt(5_000, 10, 5_000)), RATE, 0);

    assert.equal(session.drain(() => {}, 4_000, 5), 5);
  });

  test('restarting the epoch bumps the generation and clears both timelines', () => {
    const session = makeSession();
    session.start(0);
    const generation = session.generation;

    session.ingestMic(frame(0, pcmOf([7, 7, 7, 7])), RATE, 0);
    session.resetEpoch(1_000);

    assert.equal(session.generation, generation + 1);
    assert.equal(session.micGeneration, null);
    assert.equal(session.readMic(0, 1)[0], 0);
  });

  test('stopping drops the alignment with the session that measured it', () => {
    const session = makeSession();
    session.start(0);
    session.setAlignment({ calibratedMicLagMs: 250, networkCompensationMs: 40, fineTuneMs: 10 });

    session.stop();

    assert.equal(session.active, false);
    assert.deepEqual(session.alignment, {
      networkCompensationMs: 0,
      calibratedMicLagMs: null,
      fineTuneMs: 0,
    });
  });
});

describe('AudioSession microphone frontier', () => {
  /**
   * A capture that joined late and never caught up: the frontier keeps
   * advancing at the mix rate, but always from behind. This is the case the
   * buffer budget cannot bound, because the budget assumes the microphone runs
   * *ahead* of the mix clock by roughly the prebuffer.
   */
  function laggingMicSession(deficitMs: number, tailMs = 2_000) {
    const session = makeSession({ prebufferMs: 400, retentionMs: 5_000 });
    session.start(0);
    session.setMicExpected(true);
    session.setBackingExpected(true);
    session.setAlignment({ networkCompensationMs: 150 });

    const frameSamples = Math.round(RATE * 0.02);
    const totalMs = deficitMs + tailMs;
    // The song side is complete from the start; only the microphone is late.
    const backingSamples = Math.round((RATE * (totalMs + 500)) / 1000);
    session.ingestBacking(frame(0, pcmOf(new Array(backingSamples).fill(1_000))), RATE, 0);

    // One frame anchors the microphone timeline, then the mix clock is allowed
    // to run `deficitMs` past it before the stream resumes at the mix rate.
    session.ingestMic(frame(0, pcmOf(new Array(frameSamples).fill(8_000))), RATE, 0);
    drainAll(session, deficitMs);

    let micAt = frameSamples;
    for (let elapsed = deficitMs; elapsed < totalMs; elapsed += 20) {
      session.ingestMic(frame(micAt, pcmOf(new Array(frameSamples).fill(8_000))), RATE, elapsed);
      micAt += frameSamples;
      drainAll(session, elapsed + 20);
    }
    return session;
  }

  test('playability tolerates brief packet jitter but fails after sustained live-frontier starvation', () => {
    const session = makeSession({ prebufferMs: 0, retentionMs: 3_000 });
    session.start(0);
    session.setMicExpected(true);
    session.setBackingExpected(true);

    const frameSamples = Math.round(RATE * 0.02);
    session.ingestBacking(
      frame(0, pcmOf(new Array(RATE).fill(1_000))),
      RATE,
      0,
    );
    session.ingestMic(
      frame(0, pcmOf(new Array(frameSamples).fill(8_000))),
      RATE,
      0,
    );

    drainAll(session, 180);
    assert.equal(
      session.micPlayable,
      true,
      'sub-safety-window packet starvation should not flap product health',
    );

    drainAll(session, 260);
    assert.equal(
      session.micPlayable,
      false,
      'sustained missing live-frontier samples must stop being called playable',
    );
    assert.equal(session.backingPlayable, true);

    const freshAt = Math.round(RATE * 0.26);
    session.ingestMic(
      frame(freshAt, pcmOf(new Array(frameSamples * 2).fill(8_000))),
      RATE,
      260,
    );
    drainAll(session, 280);
    assert.equal(
      session.micPlayable,
      true,
      'fresh positioned PCM at the live frontier must restore playability immediately',
    );
  });

  test('a positioned sample hole becomes unplayable even when the future frontier is already present', () => {
    const session = makeSession({ prebufferMs: 0, retentionMs: 3_000 });
    session.start(0);
    session.setMicExpected(true);
    session.setBackingExpected(true);

    const frameSamples = Math.round(RATE * 0.02);
    session.ingestBacking(
      frame(0, pcmOf(new Array(RATE).fill(1_000))),
      RATE,
      0,
    );
    session.ingestMic(
      frame(0, pcmOf(new Array(frameSamples).fill(8_000))),
      RATE,
      0,
    );
    session.ingestMic(
      frame(Math.round(RATE * 0.4), pcmOf(new Array(frameSamples * 2).fill(8_000))),
      RATE,
      0,
    );

    drainAll(session, 260);
    assert.ok(
      session.health().micHeadroomMs >= 0,
      'future positioned PCM keeps the raw frontier ahead of the read head',
    );
    assert.equal(
      session.micPlayable,
      false,
      'a sustained internal hole is still emitted silence and must not be called playable',
    );

    drainAll(session, 420);
    assert.equal(
      session.micPlayable,
      true,
      'playability must recover when the mixer reaches fresh positioned PCM again',
    );
  });

  test('a microphone timeline behind the mix clock is still audible, not silence', () => {
    const session = laggingMicSession(900);

    assert.ok(
      session.appliedMicAdvanceMs < 0,
      `the read head must be held behind the frontier that exists, saw ${session.appliedMicAdvanceMs} ms`,
    );
    assert.ok(
      session.micFrontierCorrectionMs > 0,
      `the product must be able to distinguish runtime frontier correction, saw ${session.micFrontierCorrectionMs} ms`,
    );
    assert.ok(
      session.health().micHeadroomMs >= 0,
      `the mixer must not keep reading past arrived audio, saw ${session.health().micHeadroomMs} ms`,
    );
    const evidence = session.readMic(0, RATE);
    assert.ok(evidence.some((v) => v !== 0), 'the microphone history must still hold real audio');
  });

  test('releasing a held frontier correction does not splice the Mic every 20 ms', () => {
    const session = makeSession({ prebufferMs: 400, retentionMs: 3_000 });
    session.setMicGainDb(0);
    session.start(0);
    session.setMicExpected(true);
    session.setAlignment({ networkCompensationMs: 200 });

    const samples = RATE * 2;
    const tone = new Array(samples);
    for (let sample = 0; sample < samples; sample += 1) {
      tone[sample] = Math.round(
        10_000 * Math.sin((2 * Math.PI * 1_000 * sample) / RATE),
      );
    }
    session.ingestMic(frame(0, pcmOf(tone)), RATE, 0);

    // Isolate release DSP from acquisition policy: the neighbouring tests prove
    // how this held correction is acquired. With ample fresh frontier ahead,
    // updateMicFrontierCorrection() now gives it back at the documented 1%
    // rate, about 9.6 samples per 20 ms frame at 48 kHz.
    (session as any).micFrontierCorrectionSamples = Math.round(RATE * 0.02);

    const mixed: Buffer[] = [];
    session.drain((pcm) => mixed.push(pcm), 400, 1);
    session.drain((pcm) => mixed.push(pcm), 420, 1);
    assert.equal(mixed.length, 2);

    const frameSamples = Math.round(RATE * 0.02);
    const before = mixed[0].readInt16LE((frameSamples - 1) * 2);
    const after = mixed[1].readInt16LE(0);
    const boundaryStep = Math.abs(after - before);

    assert.ok(
      boundaryStep < 3_000,
      `frontier correction release spliced the Mic waveform at the frame boundary: ${boundaryStep}`,
    );
    assert.ok(
      session.micFrontierCorrectionMs < 20,
      'the correction must still release; continuity cannot freeze recovery',
    );
  });

  test('the correction is held, so the read head keeps advancing between packets', () => {
    // Re-deriving the bound every frame would pin the read position to arrival
    // and replay the same samples whenever a packet was late.
    const session = laggingMicSession(900);
    const settled = session.appliedMicAdvanceMs;
    const starvedAfterSettling = session.health().micStarvedFrames;

    const frameSamples = Math.round(RATE * 0.02);
    let micAt = session.micTotalSamples;
    for (let elapsed = 2_900; elapsed < 3_900; elapsed += 20) {
      session.ingestMic(frame(micAt, pcmOf(new Array(frameSamples).fill(8_000))), RATE, elapsed);
      micAt += frameSamples;
      drainAll(session, elapsed + 20);
    }

    const drift = Math.abs(session.appliedMicAdvanceMs - settled);
    assert.ok(
      drift < 50,
      `a steady deficit must not move the read head by packet-sized steps, drifted ${drift.toFixed(1)} ms`,
    );
    assert.equal(
      session.health().micStarvedFrames,
      starvedAfterSettling,
      'a held correction must not starve once it has taken effect',
    );
  });

  test('a microphone that stops is reported as starving, not replayed', () => {
    // The difference between *behind* and *stopped*. Chasing a frozen frontier
    // would pin the read head to the last samples that arrived and replay them
    // as though they were live, which a Take would then record.
    const session = laggingMicSession(200, 600);
    const starvedWhileHealthy = session.health().micStarvedFrames;

    // The phone goes away; the song keeps playing.
    drainAll(session, 4_000);

    assert.ok(
      session.health().micStarvedFrames > starvedWhileHealthy,
      'a stopped microphone must still be reported as starvation',
    );
    assert.ok(
      session.health().micHeadroomMs < 0,
      `a stopped microphone must show negative headroom, saw ${session.health().micHeadroomMs} ms`,
    );
  });

  test('a Phone capture-dispatch hole stays a gap instead of becoming -2.8 s latency', () => {
    const session = makeSession({ prebufferMs: 400, retentionMs: 3_000 });
    session.start(0);
    session.setMicExpected(true);
    session.setBackingExpected(true);
    session.setAlignment({ networkCompensationMs: 140 });

    const initialMicSamples = Math.round(RATE * 0.5);
    const droppedBacklogSamples = Math.round(RATE * 3);
    const freshFrameSamples = Math.round(RATE * 0.02);
    session.ingestBacking(
      frame(0, pcmOf(new Array(RATE * 5).fill(1_000))),
      RATE,
      0,
    );
    session.ingestMic(
      frame(0, pcmOf(new Array(initialMicSamples).fill(8_000))),
      RATE,
      0,
    );

    // The Phone main thread is unavailable for three seconds. #344 drops those
    // stale AudioWorklet chunks before WT/WS but still advances the capture
    // cursor, so the server receives no old voice to mistake for live latency.
    drainAll(session, 3_500);
    assert.equal(
      session.appliedMicAdvanceMs,
      140,
      'a stopped frontier must remain starvation, not grow a latency correction',
    );

    // The first fresh chunk carries the capture position after all stale local
    // chunks that were intentionally dropped. AudioSession must preserve that
    // skipped interval as a hole and put fresh PCM back near the live frontier.
    const freshFirstSampleIndex = initialMicSamples + droppedBacklogSamples;
    session.ingestMic(
      frame(
        freshFirstSampleIndex,
        pcmOf(new Array(freshFrameSamples).fill(8_000)),
      ),
      RATE,
      3_500,
    );
    drainAll(session, 3_520);

    assert.equal(
      session.health().micGapMs,
      3_000,
      'pre-transport backlog drops remain a truthful three-second sample hole',
    );
    assert.equal(
      session.appliedMicAdvanceMs,
      140,
      'fresh positioned PCM must not reinterpret the dropped backlog as the -2.8 s retention floor',
    );
    assert.equal(
      session.micFrontierCorrectionMs,
      0,
      'a truthful capture-dispatch hole must not leave a runtime frontier correction behind',
    );
    assert.ok(
      session.health().micHeadroomMs >= 0,
      `fresh PCM should restore live frontier headroom, saw ${session.health().micHeadroomMs} ms`,
    );
  });

  test('fast backlog catch-up after a stall is not promoted into stable live latency', () => {
    const session = makeSession({ prebufferMs: 400, retentionMs: 3_000 });
    session.start(0);
    session.setMicExpected(true);
    session.setBackingExpected(true);
    session.setAlignment({ networkCompensationMs: 140 });

    const frameSamples = Math.round(RATE * 0.02);
    const doubleFrameSamples = frameSamples * 2;
    session.ingestBacking(
      frame(0, pcmOf(new Array(RATE * 8).fill(1_000))),
      RATE,
      0,
    );
    session.ingestMic(frame(0, pcmOf(new Array(frameSamples).fill(8_000))), RATE, 0);

    // Delivery stalls for three seconds. This is the legacy-page rollout case:
    // there is no worklet-age fence, so once the main thread recovers it drains
    // the queued PCM faster than realtime instead of dropping it locally.
    drainAll(session, 3_000);
    assert.equal(session.micFrontierCorrectionMs, 0);

    let micAt = frameSamples;
    let maxCorrectionMs = 0;
    for (let elapsed = 3_000; elapsed < 6_000; elapsed += 20) {
      // Consume 40 ms of queued capture for every 20 ms of mix time: the
      // frontier is visibly catching up rather than establishing a steady
      // multi-second-late live clock.
      session.ingestMic(
        frame(micAt, pcmOf(new Array(doubleFrameSamples).fill(8_000))),
        RATE,
        elapsed,
      );
      micAt += doubleFrameSamples;
      drainAll(session, elapsed + 20);
      maxCorrectionMs = Math.max(maxCorrectionMs, session.micFrontierCorrectionMs);
    }

    assert.ok(
      maxCorrectionMs < 50,
      `fast catch-up must not be promoted into a retention-floor correction, saw ${maxCorrectionMs} ms`,
    );
    assert.ok(
      Math.abs(session.appliedMicAdvanceMs - 140) < 1,
      `once backlog catches up the requested +140 ms alignment should still serve, saw ${session.appliedMicAdvanceMs} ms`,
    );
    assert.ok(
      session.health().micHeadroomMs >= 0,
      `catch-up should restore live frontier headroom, saw ${session.health().micHeadroomMs} ms`,
    );
  });

  test('resuming one stale frame after a stall cannot jump to the retention clamp', () => {
    const session = makeSession({ prebufferMs: 400, retentionMs: 3_000 });
    session.start(0);
    session.setMicExpected(true);
    session.setBackingExpected(true);
    session.setAlignment({ networkCompensationMs: 140 });

    const frameSamples = Math.round(RATE * 0.02);
    const backingSamples = Math.round(RATE * 5);
    session.ingestBacking(
      frame(0, pcmOf(new Array(backingSamples).fill(1_000))),
      RATE,
      0,
    );

    // The capture starts normally, then its delivery path stops long enough to
    // become a true stall. The mixer must starve rather than chase a frozen
    // frontier backwards through retained history.
    session.ingestMic(frame(0, pcmOf(new Array(frameSamples).fill(8_000))), RATE, 0);
    drainAll(session, 3_000);
    const beforeResume = session.appliedMicAdvanceMs;
    assert.ok(beforeResume > -1_000, `fixture should not already be pinned, saw ${beforeResume} ms`);

    // A queued old frame arrives after the stall. One stale packet is not proof
    // that this is now a stable multi-second-late live stream. The old code
    // reset idleFrames on this packet and immediately drove the 3 s retention
    // budget to its -2.8 s safety boundary.
    session.ingestMic(
      frame(frameSamples, pcmOf(new Array(frameSamples).fill(8_000))),
      RATE,
      3_000,
    );
    drainAll(session, 3_020);

    assert.ok(
      Math.abs(session.appliedMicAdvanceMs - beforeResume) < 50,
      `a single stale resume packet must not deepen frontier correction: ${beforeResume} -> ${session.appliedMicAdvanceMs} ms`,
    );
    assert.ok(
      session.health().micHeadroomMs < 0,
      'stale backlog remains starvation instead of being relabeled as latency',
    );

    // Let the bounded resume guard expire with no further Mic progress. There
    // must not be a one-frame gap between "guard ended" and "stalled again"
    // where the full outage can still be captured as a frontier correction.
    drainAll(session, 3_400);
    assert.ok(
      Math.abs(session.appliedMicAdvanceMs - beforeResume) < 50,
      `an isolated stale packet must stay starvation after guard expiry: ${beforeResume} -> ${session.appliedMicAdvanceMs} ms`,
    );
  });

  test('restarting the capture drops the correction instead of unwinding it for a song', () => {
    // A new capture epoch is anchored to the current mix clock, so it starts
    // with healthy headroom and owes nothing to the old deficit. Carrying the
    // correction forward would hold the read head a second behind fresh audio
    // and give it back only at the slew rate - about 10 ms per second, so most
    // of a song before the vocal is where it belongs.
    const session = laggingMicSession(900);
    assert.ok(session.appliedMicAdvanceMs < -500, 'the fixture must have taken a real correction');

    const frameSamples = Math.round(RATE * 0.02);
    // The phone restarts its microphone: a new capture generation, from index 0.
    session.ingestMic(frame(0, pcmOf(new Array(frameSamples).fill(8_000)), 2), RATE, 2_900);

    assert.equal(
      session.appliedMicAdvanceMs,
      150,
      'a fresh capture epoch must start from the requested alignment, not the old correction',
    );
  });

  test('a healthy microphone timeline is left entirely alone', () => {
    const session = makeSession({ prebufferMs: 400, retentionMs: 5_000 });
    session.start(0);
    session.setMicExpected(true);
    session.setBackingExpected(true);

    const total = Math.round(RATE * 3);
    session.ingestBacking(frame(0, pcmOf(new Array(total).fill(1_000))), RATE, 0);
    session.ingestMic(frame(0, pcmOf(new Array(total).fill(8_000))), RATE, 0);
    session.setAlignment({ networkCompensationMs: 150 });

    drainAll(session, 2_000);
    assert.equal(
      session.appliedMicAdvanceMs,
      150,
      'a frontier with slack must leave the requested advance untouched',
    );
    assert.equal(session.health().micStarvedFrames, 0);
  });
});
