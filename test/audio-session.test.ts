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
    assert.equal(read[chunk], 0, 'the hole reads as the silence that actually happened');
    assert.equal(read[chunk * 2], 2000, 'later audio keeps its original position');
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

  test('a microphone timeline behind the mix clock is still audible, not silence', () => {
    const session = laggingMicSession(900);

    assert.ok(
      session.appliedMicAdvanceMs < 0,
      `the read head must be held behind the frontier that exists, saw ${session.appliedMicAdvanceMs} ms`,
    );
    assert.ok(
      session.health().micHeadroomMs >= 0,
      `the mixer must not keep reading past arrived audio, saw ${session.health().micHeadroomMs} ms`,
    );
    const evidence = session.readMic(0, RATE);
    assert.ok(evidence.some((v) => v !== 0), 'the microphone history must still hold real audio');
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
