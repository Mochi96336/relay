import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MicTrack } from '../src/mic-track.js';
import { AudioSession } from '../src/audio-session.js';
import { readPcmEvidence } from '../src/pcm-timeline.js';

/**
 * Component ownership contract for the FIRST step of the N=1 extraction.
 * Bit-exact output parity is guarded separately by audio-session-golden.test.ts.
 * This test does not claim MicTrack is a full independent processor yet.
 */
const config = {
  sampleRate: 48_000, prebufferMs: 400, retentionMs: 3_000,
  frameMs: 20, frameSamples: 960,
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

  test('native sample-to-room mapping uses each Mic capture origin and its source rate', () => {
    const a = new MicTrack(config);
    const b = new MicTrack(config);
    a.timeline.originOffset = 960;
    b.timeline.originOffset = 2880;
    assert.equal(a.sourceSampleToSessionSample(441, 44_100), 1440);
    assert.equal(b.sourceSampleToSessionSample(441, 44_100), 3360);
    assert.equal(a.sourceSampleToSessionSample(480, 48_000), 1440);
    assert.equal(b.sourceSampleToSessionSample(480, 48_000), 3360);
    // Changing A's capture anchor cannot silently change B's clock.
    a.timeline.originOffset = -240;
    assert.equal(a.sourceSampleToSessionSample(441, 44_100), 240);
    assert.equal(b.sourceSampleToSessionSample(441, 44_100), 3360);
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

  test('two independently signed calibrations read the correct true PCM events', () => {
    const a = new MicTrack(config);
    const b = new MicTrack(config);
    const pcmA = new Int16Array(30_000);
    const pcmB = new Int16Array(30_000);
    const roomSample = 20_000;
    const eventWithinFrame = 400;
    const advanceA = 5_760; // +120ms at 48 kHz
    const advanceB = -16_320; // -340ms at 48 kHz
    // Ground truth is fixed from the intended source timeline, NOT
    // computed from the planner's output.
    pcmA[roomSample + advanceA + eventWithinFrame] = 10_000;
    pcmB[roomSample + advanceB + eventWithinFrame] = 16_000;
    for (const [track, samples] of [[a, pcmA], [b, pcmB]] as const) {
      track.timeline.chunks.push({ start: 0, samples, positioned: true });
      track.timeline.totalSamples = samples.length;
    }
    a.alignmentState.calibratedMicLagMs = 120;
    b.alignmentState.calibratedMicLagMs = -340;
    const planA = a.planMicRead(roomSample, false);
    const planB = b.planMicRead(roomSample, false);
    assert.equal(planA.micReadStart, roomSample + advanceA);
    assert.equal(planB.micReadStart, roomSample + advanceB);
    assert.equal(planA.canCrossfadeReadHeadJump, false);
    assert.equal(planB.canCrossfadeReadHeadJump, false);
    const frameA = a.readMicFrame(planA);
    const frameB = b.readMicFrame(planB);
    assert.equal(frameA.samples[eventWithinFrame], 10_000);
    assert.equal(frameB.samples[eventWithinFrame], 16_000);
    assert.equal(frameA.evidence.gapSamples, 0);
    assert.equal(frameB.evidence.frontierMissingSamples, 0);
    assert.equal(a.alignmentState.calibratedMicLagMs, 120);
    assert.equal(b.alignmentState.calibratedMicLagMs, -340);
  });

  test('one singer frontier starvation does not modify another singer planner', () => {
    const a = new MicTrack(config);
    const b = new MicTrack(config);
    for (const track of [a, b]) {
      track.alignmentState.calibratedMicLagMs = 80;
      track.timeline.chunks.push({ start: 0, samples: new Int16Array(24_000), positioned: true });
      track.timeline.totalSamples = 24_000;
    }
    a.timeline.totalSamples = 1_200; // poor arrival frontier, but B is healthy
    a.timeline.chunks[0]!.samples = new Int16Array(1_200);
    const ap = a.planMicRead(12_000, true);
    const bp = b.planMicRead(12_000, true);
    assert.ok(a.frontier.correctionSamples >= 0);
    assert.equal(b.frontier.correctionSamples, 0);
    assert.equal(bp.micReadStart, 12_000 + 3_840);
    assert.ok(ap.micReadStart <= bp.micReadStart);
  });

  test('A source starvation and B healthy read headroom stay separate', () => {
    const a = new MicTrack(config);
    const b = new MicTrack(config);
    a.timeline.totalSamples = 20_000;
    b.timeline.totalSamples = 24_000;
    const sharedRoomSample = 19_000;
    const aPlan = a.planMicRead(sharedRoomSample, false);
    const bPlan = b.planMicRead(sharedRoomSample, false);
    a.measureReadHeadroom(aPlan, true);
    b.measureReadHeadroom(bPlan, true);
    assert.ok(a.micHeadroomMs < 0, 'A has not delivered its limiter lookahead');
    assert.ok(b.micHeadroomMs > 0, 'B still has healthy buffered PCM');
    assert.equal(a.micStarvedFrames, 1);
    assert.equal(b.micStarvedFrames, 0);
    a.measureReadHeadroom(aPlan, false);
    assert.equal(a.micStarvedFrames, 1,
      'an unexpected / released source does not count starvation again');
  });

  test('two source processors apply independent gain and limiter dynamics', () => {
    const a = new MicTrack(config);
    const b = new MicTrack(config);
    a.gain.setTargetDb(0, false);
    b.gain.setTargetDb(-6, false);
    const source = new Int16Array(1100).fill(4000);
    const input = {
      samples: source, i: 0, sourceSample: 0, micReadStart: 0,
      slew: null, slewFrameEndPosition: 0,
      evidenceMissing: false, audibleMissing: false,
    };
    const av = a.processVoiceSample(input);
    const bv = b.processVoiceSample(input);
    assert.ok(av.voice > 0 && bv.voice > 0);
    assert.ok(av.voice > bv.voice * 1.8, 'different singers keep their own Mic gain');
    assert.equal(a.lastEmittedMicSourceSample, 0);
    assert.equal(b.lastEmittedMicSourceSample, 0);
    assert.equal(av.limited, false);
    assert.equal(bv.limited, false);
    a.micLimiterResetPending = true;
    a.processVoiceSample({ ...input, i: 1, sourceSample: 1 });
    assert.equal(a.micLimiterResetPending, false);
    assert.equal(b.micLimiterResetPending, false);
  });

  test('heavy limiting on A cannot compress the independent singer B', () => {
    const a = new MicTrack(config);
    const b = new MicTrack(config);
    a.gain.setTargetDb(24, false);
    b.gain.setTargetDb(0, false);
    const hot = new Int16Array(1_300).fill(28_000);
    let hotFlags = 0;
    let coldFlags = 0;
    let lastHot = 0;
    let lastCold = 0;
    for (let i = 0; i < 400; i++) {
      const input = {
        samples: hot, i, sourceSample: i, micReadStart: 0,
        slew: null, slewFrameEndPosition: 0,
        evidenceMissing: false, audibleMissing: false,
      };
      const ar = a.processVoiceSample(input);
      const br = b.processVoiceSample(input);
      if (ar.heavilyLimited) hotFlags++;
      if (br.heavilyLimited) coldFlags++;
      lastHot = ar.voice;
      lastCold = br.voice;
    }
    assert.ok(hotFlags > 300, 'A hot microphone should trigger heavy limiting');
    assert.equal(coldFlags, 0, 'B limiter is not coupled to A');
    assert.ok(lastHot <= a.limiter.ceiling + 0.05, 'A processed voice is bounded');
    assert.ok(lastCold > 0.8 && lastCold < 0.9, 'B stays close to its own unboosted PCM');
  });

  test('source gap suppresses limiter evidence without losing gain-state progression', () => {
    const mic = new MicTrack(config);
    mic.gain.setTargetDb(0, false);
    const samples = new Int16Array(1_300).fill(8_000);
    const missing = mic.processVoiceSample({
      samples, i: 0, sourceSample: -1, micReadStart: -1,
      slew: null, slewFrameEndPosition: 0,
      evidenceMissing: true, audibleMissing: true,
    });
    assert.equal(missing.limited, false);
    assert.equal(missing.heavilyLimited, false);
    const recovered = mic.processVoiceSample({
      samples, i: 1, sourceSample: 1, micReadStart: 0,
      slew: null, slewFrameEndPosition: 0,
      evidenceMissing: false, audibleMissing: false,
    });
    assert.ok(Number.isFinite(recovered.voice));
    assert.equal(mic.lastEmittedMicSourceSample, 1);
  });

  test('independent Mic capture clock trims preserve deferred resampler prefixes', () => {
    const a = new MicTrack(config);
    const b = new MicTrack(config);
    a.clockTrim.setPpm(500);
    b.clockTrim.setPpm(-500);
    a.timeline.sourceFrontier = 0;
    b.timeline.sourceFrontier = 0;
    const pcm = new Int16Array(3_100);
    pcm[0] = -15_432; // the completed interpolation prefix from prior packet
    for (let i = 1; i < pcm.length; i++) pcm[i] = (i % 500) - 250;
    const params = {
      samples: pcm, sourceAlignedSampleOffset: 1,
      firstSourceSample: 0, sourceSampleCount: 3_100,
      sourceRate: 48_000, contiguous: true,
    };
    const ap = a.trimSourcePacket(params);
    const bp = b.trimSourcePacket(params);
    assert.equal(ap.length, pcm.length + 1);
    assert.equal(bp.length, pcm.length - 1);
    assert.equal(ap[0], pcm[0]);
    assert.equal(bp[0], pcm[0]);
    assert.equal(a.timeline.originOffset, 1);
    assert.equal(b.timeline.originOffset, -1);
    assert.equal(a.clockTrim.samples, 1);
    assert.equal(b.clockTrim.samples, -1);
    assert.equal(pcm.length, 3_100, 'input packet is not modified');
  });

  test('source trim cannot pay clock debt on a noncontiguous packet', () => {
    const a = new MicTrack(config);
    a.clockTrim.setPpm(500);
    a.timeline.sourceFrontier = 0;
    const pcm = new Int16Array(3_000).fill(300);
    const untrusted = a.trimSourcePacket({
      samples: pcm, sourceAlignedSampleOffset: 0,
      firstSourceSample: 0, sourceSampleCount: 3_000,
      sourceRate: 48_000, contiguous: false,
    });
    assert.strictEqual(untrusted, pcm);
    assert.equal(a.timeline.originOffset, 0);
    assert.equal(a.clockTrim.samples, 0);
    const settled = a.trimSourcePacket({
      samples: pcm, sourceAlignedSampleOffset: 0,
      firstSourceSample: 3_000, sourceSampleCount: 3_000,
      sourceRate: 48_000, contiguous: true,
    });
    assert.equal(settled.length, pcm.length + 1);
    assert.equal(a.clockTrim.samples, 1);
  });

  test('only A conceals a real voiced gap and the missing evidence remains truthful', () => {
    const a = new MicTrack(config);
    const b = new MicTrack(config);
    const tone = (first: number, count: number) => Int16Array.from(
      { length: count },
      (_, i) => Math.round(
        8_000 * Math.sin(2 * Math.PI * 220 * (first + i) / 48_000)
        + 3_000 * Math.sin(2 * Math.PI * 440 * (first + i) / 48_000),
      ),
    );
    const previous = { start: 0, samples: tone(0, 2_048), positioned: true };
    const next = { start: 3_008, samples: tone(3_008, 960), positioned: true };
    const originalNext = next.samples;
    const rawNext = originalNext.slice();
    a.timeline.chunks.push(previous, next);
    a.timeline.totalSamples = 3_968;
    assert.equal(a.concealCaptureGap(previous, next, 2_048), true);
    assert.equal(a.timeline.chunks.length, 3);
    assert.equal(a.timeline.chunks[1].concealed, true);
    assert.equal(a.timeline.chunks[1].start, 2_048);
    assert.equal(a.micConcealedSamples, 960);
    assert.equal(a.timeline.chunks[1].samples.length, 960);
    assert.equal(a.timeline.chunks[2].start, 3_008);
    assert.notStrictEqual(next.samples, originalNext, 'output-side next PCM is copy-on-write');
    assert.deepEqual(originalNext, rawNext, 'the originally received PCM remains immutable');
    const loss = readPcmEvidence(a.timeline, 2_048, 960);
    assert.equal(loss.gapSamples, 960, 'concealed PCM is still reported as real loss');
    assert.equal(loss.frontierMissingSamples, 0);
    assert.equal(b.timeline.chunks.length, 0);
    assert.equal(b.micConcealedSamples, 0);
  });

  test('an already emitted capture tail forbids retrospective concealment', () => {
    const a = new MicTrack(config);
    const previous = { start: 0, samples: new Int16Array(2_048), positioned: true };
    const next = { start: 3_008, samples: new Int16Array(960), positioned: true };
    a.timeline.chunks.push(previous, next);
    a.timeline.totalSamples = 3_968;
    a.lastEmittedMicSourceSample = 2_047;
    assert.equal(a.concealCaptureGap(previous, next, 2_048), false);
    assert.equal(a.timeline.chunks.length, 2);
    assert.equal(a.micConcealedSamples, 0);
  });

  test('Mic source rebase shifts only A own samples, clip clock and audible continuity', () => {
    const a = new MicTrack(config);
    const b = new MicTrack(config);
    for (const track of [a, b]) {
      track.timeline.chunks.push({
        start: 0, samples: new Int16Array(960).fill(4_000), positioned: true,
      });
      track.timeline.totalSamples = 960;
      track.timeline.originOffset = 40;
      track.micCaptureOriginSample = 0;
      track.lastEmittedMicSourceSample = 480;
      track.lastEmittedMicAdvanceSamples = 15.5;
    }
    a.rebaseCaptureTimeline(120);
    assert.equal(a.timeline.chunks[0].start, 120);
    assert.equal(a.timeline.totalSamples, 1_080);
    assert.equal(a.timeline.originOffset, 160);
    assert.equal(a.micCaptureOriginSample, 120);
    assert.equal(a.lastEmittedMicSourceSample, 600);
    assert.equal(a.lastEmittedMicAdvanceSamples, 135.5);
    assert.equal(b.timeline.chunks[0].start, 0);
    assert.equal(b.timeline.totalSamples, 960);
    assert.equal(b.timeline.originOffset, 40);
    assert.equal(b.micCaptureOriginSample, 0);
    assert.equal(b.lastEmittedMicSourceSample, 480);
    assert.equal(b.lastEmittedMicAdvanceSamples, 15.5);
    a.rebaseCaptureTimeline(-120);
    assert.equal(a.timeline.chunks[0].start, 0);
    assert.equal(a.timeline.originOffset, 40);
  });

  test('replaced A capture forgets its own trim without resetting B clock', () => {
    const a = new MicTrack(config);
    const b = new MicTrack(config);
    a.clockTrim.setPpm(420);
    b.clockTrim.setPpm(-380);
    a.timeline.generation = 9;
    a.onCaptureClockReplaced();
    assert.equal(a.clockTrim.ppm, 0);
    assert.equal(b.clockTrim.ppm, -380);
  });

  test('two Mic captures can ingest independently and A restart cannot reset B', () => {
    const a = new MicTrack(config);
    const b = new MicTrack(config);
    const capture = (track: MicTrack, generation: number, first: number, value: number, now: number) =>
      track.ingestCapture({
        frame: {
          generation, firstSampleIndex: first,
          pcm: Buffer.from(new Int16Array(960).fill(value).buffer),
        },
        sourceRate: 48_000, running: true, roomSampleNow: () => now,
      });
    assert.equal(capture(a, 1, 0, 6_000, 960).start, 0);
    assert.equal(capture(b, 8, 0, -9_000, 960).start, 0);
    assert.equal(a.timeline.totalSamples, 960);
    assert.equal(b.timeline.totalSamples, 960);
    const restarted = capture(a, 2, 0, 7_000, 3840);
    assert.equal(restarted.captureRestarted, true);
    assert.equal(restarted.start, 2_880);
    assert.equal(a.timeline.originOffset, 2_880);
    assert.equal(a.timeline.generation, 2);
    assert.equal(b.timeline.originOffset, 0);
    assert.equal(b.timeline.generation, 8);
    assert.equal(b.timeline.chunks.length, 1);
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
