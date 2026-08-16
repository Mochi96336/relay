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

function unheaderedFrame(value = 1_000): PcmFrame {
  return { generation: null, firstSampleIndex: null, pcm: pcm(value) };
}

function drainOne(session: AudioSession, nowMs: number): MixFrameEvidence {
  const captured: MixFrameEvidence[] = [];
  const emitted = session.drain(() => {
    const evidence = session.health().lastMixedFrame;
    if (evidence) captured.push(evidence);
  }, nowMs, 1);
  assert.equal(emitted, 1);
  const evidence = captured[0];
  assert.ok(evidence, 'mixed output must expose exact frame evidence before its callback returns');
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
