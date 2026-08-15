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
    const session = makeSession();
    session.setAlignment({ networkCompensationMs: 80 });
    assert.equal(session.appliedMicAdvanceMs, 80);

    session.setAlignment({ calibratedMicLagMs: 300 });
    assert.equal(session.appliedMicAdvanceMs, 300, 'a measurement beats the estimate');

    session.setAlignment({ fineTuneMs: 25 });
    assert.equal(session.appliedMicAdvanceMs, 275);
  });

  test('reads the microphone ahead so a delayed vocal lands on the beat', () => {
    const session = makeSession();
    session.setMicExpected(true);
    session.setBackingExpected(true);
    session.start(0);

    // The same event, 300 ms later in the microphone stream than in the song.
    session.ingestBacking(frame(0, markedAt(1_000, 400, 12_000)), RATE, 0);
    session.ingestMic(frame(0, markedAt(1_000, 700, 12_000)), RATE, 0);
    session.setAlignment({ calibratedMicLagMs: 300 });

    const mixed = drainAll(session, 700);
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
