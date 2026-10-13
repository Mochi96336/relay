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
  readHeadCrossfadeMs: 5,
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
    a.alignmentState.calibratedMicLagMs = 220;
    a.calibratedMicLagTargetMs = 330;
    a.lastEmittedMicAdvanceSamples = 1234;
    a.lastEmittedMicSourceSample = 4321;
    a.lastEmittedMicFrameComplete = true;
    a.calibrationUnfoldedSamples = 120;
    a.micHeadroomMs = 180;
    a.micConcealedSamples = 220;
    a.micStarvedFrames = 5;
    a.micUnplayableRunFrames = 6;
    a.micCaptureOriginSample = 88;
    a.micLimiterResetPending = true;
    assert.equal(b.alignmentState.calibratedMicLagMs, null);
    assert.equal(b.calibratedMicLagTargetMs, null);
    assert.equal(b.lastEmittedMicAdvanceSamples, null);
    assert.equal(b.lastEmittedMicSourceSample, null);
    assert.equal(b.lastEmittedMicFrameComplete, false);
    assert.equal(b.calibrationUnfoldedSamples, 0);
    assert.equal(b.micHeadroomMs, 0);
    assert.equal(b.micConcealedSamples, 0);
    assert.equal(b.micStarvedFrames, 0);
    assert.equal(b.micUnplayableRunFrames, 0);
    assert.equal(b.micCaptureOriginSample, null);
    assert.equal(b.micLimiterResetPending, false);

  });

  test('Mic post-ingest capture evidence stays isolated from another singer', () => {
    const a = new MicTrack(config);
    const b = new MicTrack(config);
    const firstChunk = {
      start: 0, samples: new Int16Array(960).fill(14000), positioned: true,
    };
    a.timeline.chunks.push(firstChunk);
    a.timeline.generation = 5;
    a.timeline.sourceRate = 48_000;
    a.timeline.totalSamples = 960;
    const frame = {
      generation: 5,
      firstSampleIndex: 0,
      pcm: Buffer.from(firstChunk.samples.buffer),
    };
    a.observeIngest({
      frame,
      sourceRate: 48_000,
      running: true,
      previousTotalSamples: 0,
      previousChunk: null,
      previousGeneration: null,
      previousSourceRate: null,
      previousSourceFrontier: null,
      result: { captureRestarted: true, samples: firstChunk.samples, start: 0 },
      mapSourceSample: (sample) => sample,
    });
    assert.equal(a.micCaptureOriginSample, 0);
    assert.equal(a.captureRestarts.size, 1);
    assert.ok(a.meter.peakDbfs !== null);
    assert.equal(b.micCaptureOriginSample, null);
    assert.equal(b.captureRestarts.size, 0);
    assert.equal(b.meter.peakDbfs, null);
  });

  test('canonical source frame reads remain per-singer and report actual PCM loss', () => {
    const a = new MicTrack(config);
    const b = new MicTrack(config);
    a.timeline.chunks.push({
      start: 0, samples: new Int16Array(960).fill(10_000), positioned: true,
    });
    a.timeline.totalSamples = 960;
    b.timeline.chunks.push({
      start: 0, samples: new Int16Array(960).fill(-15_000), positioned: true,
    });
    b.timeline.totalSamples = 960;
    const plan = {
      startSample: 0,
      previouslyEmittedAdvanceSamples: null,
      previousAdvanceSamplesExact: 0,
      advanceSamplesExact: 0,
      advanceSamples: 0,
      micReadStart: 0,
      boundedRuntimeAdvanceMoved: false,
      canCrossfadeReadHeadJump: false,
      crossfadeSamples: 0,
    };
    const aFrame = a.readMicFrame(plan);
    const bFrame = b.readMicFrame(plan);
    assert.equal(aFrame.samples[100], 10_000);
    assert.equal(bFrame.samples[100], -15_000);
    assert.equal(aFrame.evidence.gapSamples, 0);
    assert.equal(bFrame.evidence.gapSamples, 0);
    assert.equal(aFrame.evidence.frontierMissingSamples, 0);
    assert.equal(aFrame.samples[960], 0, 'limiter lookahead past source frontier remains silence');
    assert.equal(aFrame.frontierMissingStart, 960);
    assert.notStrictEqual(aFrame.samples, bFrame.samples);
  });

  test('two separate MicTracks perform real fractional slew with independent source PCM', () => {
    const a = new MicTrack(config);
    const b = new MicTrack(config);
    const waveform = new Int16Array(1600);
    for (let i = 0; i < waveform.length; i++) waveform[i] = i * 10;
    for (const [track, sign] of [[a, 1], [b, -1]] as const) {
      track.timeline.chunks.push({
        start: 0,
        samples: waveform.map(sample => sample * sign),
        positioned: true,
      });
      track.timeline.totalSamples = waveform.length;
    }
    const plan = {
      startSample: 0,
      previouslyEmittedAdvanceSamples: 0,
      previousAdvanceSamplesExact: 0,
      advanceSamplesExact: 9.6,
      advanceSamples: 10,
      micReadStart: 10,
      boundedRuntimeAdvanceMoved: true,
      canCrossfadeReadHeadJump: false,
      crossfadeSamples: 0,
    };
    const first = a.readMicFrame(plan);
    const second = b.readMicFrame(plan);
    assert.ok(first.slew, 'real bounded-slew interpolation is used');
    assert.equal(first.slew?.rate, 1.01);
    assert.equal(first.samples[0], 0);
    assert.ok(Math.abs(first.samples[500] - 5_050) <= 1);
    assert.equal(second.samples[500], -first.samples[500]);
    assert.equal(first.evidence.gapSamples, 0);
    assert.equal(second.evidence.frontierMissingSamples, 0);
    assert.notStrictEqual(first.samples, second.samples);
  });

  test('immediate read-head jump crossfades using only its own retained PCM', () => {
    const track = new MicTrack(config);
    const samples = new Int16Array(2600);
    for (let i = 0; i < samples.length; i++) samples[i] = i * 9;
    track.timeline.chunks.push({ start: 0, samples, positioned: true });
    track.timeline.totalSamples = samples.length;
    track.lastEmittedMicSourceSample = 959;
    const frame = track.readMicFrame({
      startSample: 960,
      previouslyEmittedAdvanceSamples: 0,
      previousAdvanceSamplesExact: 0,
      advanceSamplesExact: 96,
      advanceSamples: 96,
      micReadStart: 1056,
      boundedRuntimeAdvanceMoved: false,
      canCrossfadeReadHeadJump: true,
      crossfadeSamples: 240,
    });
    assert.equal(frame.samples[0], samples[960], 'first sample continues prior trajectory');
    assert.equal(frame.samples[239], samples[1056 + 239],
      'the last crossfade sample comes entirely from the new trajectory');
    assert.equal(frame.samples[400], samples[1056 + 400]);
    assert.equal(frame.crossfadeUnheaderedSamplesDelta, 0);
    assert.equal(frame.crossfadeInputClippedSamplesDelta, 0);
  });

  test('capture edges and calibration slew affect only their own track', () => {
    const a = new MicTrack(config);
    const b = new MicTrack(config);
    a.alignmentState.calibratedMicLagMs = 100;
    a.calibratedMicLagTargetMs = 120;
    a.advanceCalibrationSlew();
    assert.ok(Math.abs(a.alignmentState.calibratedMicLagMs! - 100.2) < 1e-9);
    assert.equal(b.alignmentState.calibratedMicLagMs, null);

    a.lastEmittedMicSourceSample = 99;
    a.captureRestarts.queue(100);
    assert.equal(a.firstUnheardSample(), 100);
    assert.equal(a.beginCaptureRestartEdgeIfDue(100), true);
    assert.equal(b.beginCaptureRestartEdgeIfDue(100), false);
    assert.equal(b.captureRestarts.size, 0);
    assert.equal(b.edge.replacementActive, false);
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
