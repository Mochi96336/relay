import assert from 'node:assert/strict';
import test from 'node:test';

import { AudioSession, type MixFrameEvidence } from '../src/audio-session.js';
import type { PcmFrame } from '../src/pcm-frame.js';

const RATE = 48_000;
const FRAME_SAMPLES = 960;

function makeSession() {
  const session = new AudioSession({
    sampleRate: RATE,
    frameMs: 20,
    prebufferMs: 0,
    backingGain: 1,
    retentionMs: 5_000,
  });
  session.setMicGainDb(0);
  return session;
}

function pcm(value = 1_000, samples = FRAME_SAMPLES) {
  const buffer = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) buffer.writeInt16LE(value, i * 2);
  return buffer;
}

function frame(firstSampleIndex: number, value = 1_000): PcmFrame {
  return { generation: 1, firstSampleIndex, pcm: pcm(value) };
}

function pcmWithRails(
  samples: number,
  railIndices: number[],
  railValue = 32_766,
) {
  const buffer = pcm(1_000, samples);
  for (const index of railIndices) buffer.writeInt16LE(railValue, index * 2);
  return buffer;
}

function positionedFrame(
  generation: number,
  firstSampleIndex: number,
  buffer: Buffer,
): PcmFrame {
  return { generation, firstSampleIndex, pcm: buffer };
}

function unheaderedFrame(value = 1_000): PcmFrame {
  return { generation: null, firstSampleIndex: null, pcm: pcm(value) };
}

function drainOne(session: AudioSession, nowMs: number): MixFrameEvidence {
  const captured: MixFrameEvidence[] = [];
  const emitted = session.drain((_frame, evidence) => captured.push(evidence), nowMs, 1);
  assert.equal(emitted, 1);
  const evidence = captured[0];
  assert.ok(evidence, 'mixed output must emit exact evidence beside its PCM frame');
  return evidence;
}

test('a PCM gap is charged when the mixer actually reads the hole, not when ingest first detects it', () => {
  const session = makeSession();
  session.setMicExpected(true);
  session.start(0);

  session.ingestMic(frame(0), RATE, 0);
  session.ingestMic(frame(FRAME_SAMPLES * 2, 2_000), RATE, 0);
  assert.equal(session.health().micGapMs, 20, 'epoch health already knows the future hole exists');

  const beforeHole = drainOne(session, 0);
  assert.equal(beforeHole.micGapSamples, 0, 'the first recorded frame is still complete');

  const hole = drainOne(session, 20);
  assert.equal(hole.micGapSamples, FRAME_SAMPLES, 'the Take sees the gap only in the frame that contains it');
  assert.equal(hole.micStarvedSamples, 0, 'an internal positioned hole is not frontier starvation');
});

test('a future gap detected by epoch health is not charged to an earlier recorded frame', () => {
  const session = makeSession();
  session.setMicExpected(true);
  session.start(0);

  session.ingestMic(frame(0), RATE, 0);
  session.ingestMic(frame(FRAME_SAMPLES * 10, 2_000), RATE, 0);
  assert.ok(session.health().micGapMs > 100);

  const evidence = drainOne(session, 0);
  assert.equal(evidence.micGapSamples, 0);
  assert.equal(evidence.micStarvedSamples, 0);
});

test('raw Mic clipping is charged only when the mixed read head reaches that source range', () => {
  const session = makeSession();
  session.setMicExpected(true);
  session.start(0);

  session.ingestMic(frame(0), RATE, 0);
  session.ingestMic(
    positionedFrame(
      1,
      FRAME_SAMPLES,
      pcmWithRails(FRAME_SAMPLES, [100, 101, 102, 103, 104, 105]),
    ),
    RATE,
    0,
  );

  const clean = drainOne(session, 0);
  assert.equal(
    clean.micInputClippedSamples,
    0,
    'future flat-top evidence must not contaminate an earlier WAV frame',
  );

  const clipped = drainOne(session, 20);
  assert.equal(clipped.micInputClippedSamples, 6);
  assert.equal(
    clipped.clippedSamples,
    0,
    'raw Mic clipping is distinct from final summing-stage output clipping',
  );
});

test('isolated full-scale peaks do not masquerade as a flat-top Mic input', () => {
  const session = makeSession();
  session.setMicExpected(true);
  session.start(0);

  session.ingestMic(
    positionedFrame(
      1,
      0,
      pcmWithRails(FRAME_SAMPLES, [100, 200, 300, 400]),
    ),
    RATE,
    0,
  );

  assert.equal(drainOne(session, 0).micInputClippedSamples, 0);
});

test('fragmented clipping ranges remain exact under bounded range lookup', () => {
  const session = makeSession();
  session.setMicExpected(true);
  session.start(0);

  const railIndices: number[] = [];
  for (let run = 0; run < 150; run += 1) {
    const start = 100 + run * 5;
    railIndices.push(start, start + 1, start + 2, start + 3);
  }
  session.ingestMic(
    positionedFrame(
      1,
      0,
      pcmWithRails(FRAME_SAMPLES, railIndices),
    ),
    RATE,
    0,
  );

  assert.equal(
    drainOne(session, 0).micInputClippedSamples,
    600,
    'binary range lookup must preserve every four-sample flat top without filling the clean separators',
  );
});

test('a flat-top run remains continuous across Mic transport packet boundaries', () => {
  const session = makeSession();
  session.setMicExpected(true);
  session.start(0);

  session.ingestMic(
    positionedFrame(
      1,
      0,
      pcmWithRails(FRAME_SAMPLES, [FRAME_SAMPLES - 2, FRAME_SAMPLES - 1]),
    ),
    RATE,
    0,
  );
  session.ingestMic(
    positionedFrame(
      1,
      FRAME_SAMPLES,
      pcmWithRails(FRAME_SAMPLES, [0, 1]),
    ),
    RATE,
    0,
  );

  assert.equal(
    drainOne(session, 0).micInputClippedSamples,
    2,
    'once the next packet proves a four-sample run, the retained previous tail is truthful clipping evidence',
  );
  assert.equal(drainOne(session, 20).micInputClippedSamples, 2);
});

test('overlap-trimmed replacement clipping is not charged to emitted Mic audio', () => {
  const session = makeSession();
  session.setMicExpected(true);
  session.start(0);

  session.ingestMic(frame(0), RATE, 0);

  // At 30 ms a fresh 20 ms capture is anchored at session sample 480. Its
  // first 480 samples overlap already-retained history and are trimmed by
  // ingest(). Put the only flat top entirely inside that discarded prefix.
  session.ingestMic(
    positionedFrame(
      2,
      0,
      pcmWithRails(FRAME_SAMPLES, [100, 101, 102, 103, 104, 105]),
    ),
    RATE,
    30,
  );
  session.ingestMic(
    positionedFrame(
      2,
      FRAME_SAMPLES,
      pcm(1_000),
    ),
    RATE,
    50,
  );

  assert.equal(drainOne(session, 0).micInputClippedSamples, 0);
  assert.equal(
    drainOne(session, 20).micInputClippedSamples,
    0,
    'clipping in replacement PCM discarded by overlap trim must never become Take evidence',
  );
});

test('a capture-generation boundary breaks an otherwise adjacent input-rail run', () => {
  const session = makeSession();
  session.setMicExpected(true);
  session.start(0);

  session.ingestMic(
    positionedFrame(
      1,
      0,
      pcmWithRails(FRAME_SAMPLES, [FRAME_SAMPLES - 2, FRAME_SAMPLES - 1]),
    ),
    RATE,
    0,
  );
  session.ingestMic(
    positionedFrame(
      2,
      0,
      pcmWithRails(FRAME_SAMPLES, [0, 1]),
    ),
    RATE,
    40,
  );

  assert.equal(drainOne(session, 0).micInputClippedSamples, 0);
  assert.equal(
    drainOne(session, 20).micInputClippedSamples,
    0,
    'two rail samples from each of two different capture clocks are not one four-sample flat top',
  );
});

test('source clipping survives high-rate capture even when resampling changes the rail shape', () => {
  const session = makeSession();
  session.setMicExpected(true);
  session.start(0);

  const sourceRate = 96_000;
  session.ingestMic(
    positionedFrame(
      1,
      0,
      pcmWithRails(1_920, [200, 201, 202, 203]),
    ),
    sourceRate,
    0,
  );

  assert.ok(
    drainOne(session, 0).micInputClippedSamples > 0,
    'flat-top evidence is detected before 96 kHz -> 48 kHz resampling can blur it',
  );
});

test('disconnect does not become unavailable evidence until buffered audio is actually exhausted', () => {
  const session = makeSession();
  session.setMicExpected(true);
  session.start(0);
  session.ingestMic({
    generation: 1,
    firstSampleIndex: 0,
    pcm: pcm(1_000, FRAME_SAMPLES * 2),
  }, RATE, 0);

  session.setMicExpected(false);
  const first = drainOne(session, 0);
  const second = drainOne(session, 20);
  const exhausted = drainOne(session, 40);

  assert.equal(first.micUnavailableSamples, 0);
  assert.equal(second.micUnavailableSamples, 0);
  assert.equal(exhausted.micUnavailableSamples, FRAME_SAMPLES);
  assert.equal(exhausted.micStarvedSamples, 0, 'an absent source is unavailable, not a live-source starvation');
});

test('missing limiter lookahead does not pretend emitted microphone samples were starved', () => {
  const session = makeSession();
  session.setMicExpected(true);
  session.start(0);
  session.ingestMic(frame(0), RATE, 0);

  const evidence = drainOne(session, 0);
  assert.ok(session.health().micStarvedFrames > 0, 'engineering headroom still includes limiter lookahead');
  assert.equal(
    evidence.micStarvedSamples,
    0,
    'Take evidence covers only the microphone samples emitted in the WAV frame',
  );
});

test('legacy unpositioned PCM is attributed only when those source samples reach mixed output', () => {
  const session = makeSession();
  session.setMicExpected(true);
  session.start(0);
  session.ingestMic(unheaderedFrame(), RATE, 0);

  assert.equal(session.health().unheadered, true);
  const evidence = drainOne(session, 0);
  assert.equal(evidence.unheaderedSamples, FRAME_SAMPLES);
});
