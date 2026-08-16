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
    assert.ok(peak.value > 20_000, `the two should sum, got ${peak.value}`);
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

  test('still reports a clamp when the sum overflows despite the limiter', () => {
    // The limiter only holds the voice down; the song is added after it.
    const session = makeSession({ backingGain: 1 });
    session.setMicGainDb(36);
    session.start(0);
    session.ingestMic(frame(0, sung(1, 3_200)), RATE, 0);
    session.ingestBacking(frame(0, pcmOf(new Array(RATE).fill(30_000))), RATE, 0);

    drainAll(session, 500);
    assert.ok(session.health().clippedSamples > 0, 'the backstop still has to report itself');
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
