import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MicTrack } from '../src/mic-track.js';
import { AudioSession } from '../src/audio-session.js';

/**
 * Component ownership contract for the FIRST step of the N=1 extraction.
 * Bit-exact output parity is guarded separately by audio-session-golden.test.ts.
 * This test does not claim MicTrack is a full independent processor yet.
 */
const config = {
  sampleRate: 48_000, frameMs: 20, frameSamples: 960,
  sourceEdgeFadeSamples: 96, safetyMs: 200, slewFraction: .01,
};

describe('extracted MicTrack owns per-singer components independently', () => {
  test('two tracks allocate separate buffers, per-capture dynamics and clocks', () => {
    const a = new MicTrack(config);
    const b = new MicTrack(config);
    assert.notStrictEqual(a.timeline, b.timeline);
    assert.notStrictEqual(a.timeline.chunks, b.timeline.chunks);
    assert.notStrictEqual(a.gain, b.gain);
    assert.notStrictEqual(a.limiter, b.limiter);
    assert.notStrictEqual(a.meter, b.meter);
    assert.notStrictEqual(a.captureRestarts, b.captureRestarts);
    assert.notStrictEqual(a.clipping, b.clipping);
    assert.notStrictEqual(a.edge, b.edge);
    assert.notStrictEqual(a.frontier, b.frontier);
    assert.notStrictEqual(a.clockTrim, b.clockTrim);

    a.timeline.totalSamples = 960;
    a.timeline.generation = 1;
    a.gain.setTargetDb(6, false);
    assert.equal(b.timeline.totalSamples, 0);
    assert.equal(b.timeline.generation, null);
    assert.equal(a.gain.targetDb, 6);
    assert.equal(b.gain.targetDb, 24, 'independent B keeps the Relay default +24 dB');
  });

  test('current AudioSession still uses its actual existing Mic clock and limits', () => {
    const session = new AudioSession({
      sampleRate: 48_000, frameMs: 20, prebufferMs: 400,
      backingGain: .65, retentionMs: 3_000,
    });
    session.start(0);
    session.setMicExpected(true);
    session.ingestMic({
      generation: 1, firstSampleIndex: 0,
      pcm: Buffer.from(new Int16Array(1920).fill(12_000).buffer),
    }, 48_000, 0);
    assert.equal(session.micGeneration, 1);
    assert.equal(session.micTotalSamples, 1920);
    assert.equal(session.readMic(0, 1920).filter(x => x !== 0).length, 1920);
  });
});
