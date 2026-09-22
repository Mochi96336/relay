import assert from 'node:assert/strict';
import test from 'node:test';

import { AudioSession } from '../src/audio-session.js';
import type { PcmFrame } from '../src/pcm-frame.js';

const RATE = 48_000;
const CHUNK = Math.round(RATE * 0.02);
const FADE = Math.round(RATE * 0.002);
const AMPLITUDE = 12_000;

function pcm(samples: number, value = AMPLITUDE) {
  const buffer = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) buffer.writeInt16LE(value, i * 2);
  return buffer;
}

function frame(firstSampleIndex: number, samples = CHUNK, value = AMPLITUDE): PcmFrame {
  return {
    generation: 1,
    firstSampleIndex,
    pcm: pcm(samples, value),
  };
}

function makeSession() {
  const session = new AudioSession({
    sampleRate: RATE,
    frameMs: 20,
    prebufferMs: 0,
    backingGain: 1,
    retentionMs: 5_000,
  });
  session.setMicGainDb(0);
  session.start(0);
  return session;
}

function drainOne(session: AudioSession, nowMs: number) {
  let output: Buffer | null = null;
  let evidence: any = null;
  const drained = session.drain((frameBuffer, frameEvidence) => {
    output = frameBuffer;
    evidence = frameEvidence;
  }, nowMs, 1);
  assert.equal(drained, 1);
  if (!output || !evidence) throw new Error('expected one mixed frame');
  return { output, evidence };
}

function sample(output: Buffer, index: number) {
  return output.readInt16LE(index * 2);
}

test('Mic frontier exhaustion inside a frame tapers at the emitted boundary without hiding starvation', () => {
  const session = makeSession();
  session.setMicExpected(true);

  const realSamples = CHUNK / 2;
  session.ingestMic(frame(0, realSamples), RATE, 0);

  const { output, evidence } = drainOne(session, 0);
  const missingStart = realSamples;

  assert.ok(Math.abs(sample(output, missingStart - 1) - AMPLITUDE) <= 1);
  assert.ok(
    Math.abs(sample(output, missingStart) - sample(output, missingStart - 1)) <= 1,
    'the first unavailable sample must continue the last audible Mic contribution',
  );
  assert.equal(
    sample(output, missingStart + FADE - 1),
    0,
    'the bounded Mic frontier taper must reach silence inside 2 ms',
  );
  assert.equal(sample(output, missingStart + FADE), 0);
  assert.equal(evidence.micStarvedSamples, CHUNK - realSamples);
  assert.equal(evidence.micUnavailableSamples, 0);
  assert.deepEqual(session.readMicEvidence(0, CHUNK), {
    gapSamples: 0,
    frontierMissingSamples: CHUNK - realSamples,
    unheaderedSamples: 0,
  }, 'the audible taper must not rewrite raw frontier evidence');
});

test('Mic ownership release de-clicks the eventual frontier without reclassifying unavailable PCM', () => {
  const session = makeSession();
  session.setMicExpected(true);
  session.ingestMic(frame(0), RATE, 0);

  const before = drainOne(session, 0);
  assert.ok(Math.abs(sample(before.output, CHUNK - 1) - AMPLITUDE) <= 1);

  // Mirrors release/disconnect semantics: expectation changes, retained PCM does
  // not get synchronously erased. The next frame naturally exhausts the frontier.
  session.setMicExpected(false);
  const missing = drainOne(session, 20);

  assert.ok(
    Math.abs(sample(missing.output, 0) - sample(before.output, CHUNK - 1)) <= 1,
    'releasing ownership must not turn the retained Mic frontier into a one-sample cut',
  );
  assert.equal(sample(missing.output, FADE - 1), 0);
  assert.equal(sample(missing.output, FADE), 0);
  assert.equal(missing.evidence.micStarvedSamples, 0);
  assert.equal(missing.evidence.micUnavailableSamples, CHUNK);
});

test('Mic late contiguous recovery fades in even when the raw timeline later has no gap', () => {
  const session = makeSession();
  session.setMicExpected(true);
  session.ingestMic(frame(0), RATE, 0);

  drainOne(session, 0);
  const missing = drainOne(session, 20);
  assert.equal(missing.evidence.micStarvedSamples, CHUNK);
  assert.equal(sample(missing.output, FADE - 1), 0);

  // These packets are source-contiguous. They arrive only after frame 1 was
  // already emitted as starvation, so the stored timeline becomes gap-free even
  // though the listener actually heard silence during that frame.
  // Catch-up can arrive as a burst. Give the Mic enough real headroom that its
  // independent 200 ms frontier-safety correction does not deliberately keep
  // the read head in older/pre-roll audio; this test isolates the audible
  // starvation edge rather than that latency policy.
  for (let index = 1; index < 16; index += 1) {
    session.ingestMic(frame(CHUNK * index), RATE, 40);
  }

  assert.equal(session.health().micGapMs, 0);
  assert.equal(session.readMic(CHUNK * 2, 1)[0], AMPLITUDE);

  const recovered = drainOne(session, 40);
  assert.equal(recovered.evidence.micGapSamples, 0);
  assert.equal(recovered.evidence.micStarvedSamples, 0);
  assert.equal(sample(recovered.output, 0), 0, 'recovered Mic enters from emitted silence');
  assert.ok(
    Math.abs(sample(recovered.output, FADE - 1) - AMPLITUDE) <= 1,
    'recovered Mic reaches the real waveform inside 2 ms',
  );
  assert.ok(Math.abs(sample(recovered.output, FADE) - AMPLITUDE) <= 1);
});

test('Mic recovery keeps its fade pending across structural or source silence', () => {
  const session = makeSession();
  session.setMicExpected(true);
  session.ingestMic(frame(0), RATE, 0);

  drainOne(session, 0);
  drainOne(session, 20);

  // A catch-up burst is contiguous but resumes with 1 ms of actual source
  // silence. The recovery edge must not be consumed by those zero samples.
  const silentThenTone = Buffer.alloc(CHUNK * 2);
  for (let i = RATE / 1000; i < CHUNK; i += 1) {
    silentThenTone.writeInt16LE(AMPLITUDE, i * 2);
  }
  session.ingestMic({
    generation: 1,
    firstSampleIndex: CHUNK,
    pcm: pcm(CHUNK),
  }, RATE, 40);
  session.ingestMic({
    generation: 1,
    firstSampleIndex: CHUNK * 2,
    pcm: silentThenTone,
  }, RATE, 40);
  for (let index = 3; index < 16; index += 1) {
    session.ingestMic(frame(CHUNK * index), RATE, 40);
  }

  const recovered = drainOne(session, 40);
  const toneStart = RATE / 1000;
  assert.equal(sample(recovered.output, 0), 0);
  assert.equal(sample(recovered.output, toneStart - 1), 0);
  assert.equal(
    sample(recovered.output, toneStart),
    0,
    'the first audible sample after real source silence must still enter from silence',
  );
  assert.ok(
    Math.abs(sample(recovered.output, toneStart + FADE - 1) - AMPLITUDE) <= 1,
    'the pending recovery edge reaches the real waveform within 2 ms of first sound',
  );
});

for (const source of ['mic', 'backing'] as const) {
  test(`${source} one-sample late-discovered gap recovers from the audible fade, not assumed silence`, () => {
    const session = makeSession();
    if (source === 'mic') session.setMicExpected(true);
    else session.setBackingExpected(true);

    const ingest = source === 'mic'
      ? (frameValue: PcmFrame, nowMs: number) => session.ingestMic(frameValue, RATE, nowMs)
      : (frameValue: PcmFrame, nowMs: number) => session.ingestBacking(frameValue, RATE, nowMs);

    ingest(frame(0), 0);
    const before = drainOne(session, 0);
    const beforeLast = sample(before.output, CHUNK - 1);
    assert.ok(Math.abs(beforeLast - AMPLITUDE) <= 1);

    // The next packet arrives only after frame 0 was emitted and proves exactly
    // one missing positioned sample. The missing fade therefore has only one
    // sample to run before real source PCM returns.
    ingest(frame(CHUNK + 1), 20);
    if (source === 'mic') {
      // Give Mic frontier safety enough real future PCM that the read head stays
      // on this exact one-sample hole. Backing has no independent hold-back
      // policy, so it needs no extra fixture headroom.
      for (let index = 1; index < 16; index += 1) {
        ingest(frame(CHUNK + 1 + CHUNK * index), 20);
      }
    }
    const evidence = source === 'mic'
      ? session.readMicEvidence(CHUNK, CHUNK)
      : session.readBackingEvidence(CHUNK, CHUNK);
    assert.equal(evidence.gapSamples, 1);

    const recovered = drainOne(session, 20);
    const firstMissing = sample(recovered.output, 0);
    const firstRecovered = sample(recovered.output, 1);
    assert.ok(
      Math.abs(firstMissing - beforeLast) <= 1,
      'the single missing sample must continue the already-emitted edge',
    );
    assert.ok(
      Math.abs(firstRecovered - firstMissing) < 1_518,
      `short-gap recovery must continue from the audible edge: ${firstMissing} -> ${firstRecovered}`,
    );

    let maxStep = 0;
    for (let index = 1; index < Math.min(CHUNK, FADE * 2); index += 1) {
      maxStep = Math.max(
        maxStep,
        Math.abs(sample(recovered.output, index) - sample(recovered.output, index - 1)),
      );
    }
    assert.ok(maxStep < 1_518, `short-gap recovery emitted a hard splice: ${maxStep}`);
  });
}

test('late-discovered positioned gap tapers from already-emitted Mic into silence', () => {
  const session = makeSession();
  session.setMicExpected(true);
  session.ingestMic(frame(0), RATE, 0);

  const before = drainOne(session, 0);
  const beforeLast = sample(before.output, CHUNK - 1);
  assert.ok(Math.abs(beforeLast - AMPLITUDE) <= 1);

  // The previous Mic frame is already audible when this later positioned
  // packet proves a complete 20 ms hole immediately after it.
  session.ingestMic(frame(CHUNK * 2), RATE, 20);
  assert.deepEqual(session.readMicEvidence(CHUNK, CHUNK), {
    gapSamples: CHUNK,
    frontierMissingSamples: 0,
    unheaderedSamples: 0,
  });

  const missing = drainOne(session, 20);
  assert.ok(
    Math.abs(sample(missing.output, 0) - beforeLast) <= 1,
    'first newly-proven Mic gap sample must continue the already-emitted vocal edge',
  );
  assert.equal(sample(missing.output, FADE - 1), 0);
  assert.equal(sample(missing.output, FADE), 0);
  assert.equal(missing.evidence.micGapSamples, CHUNK);
  assert.equal(missing.evidence.micStarvedSamples, 0);
});

test('late-discovered positioned gap tapers from already-emitted Backing into silence', () => {
  const session = makeSession();
  session.setBackingExpected(true);
  session.ingestBacking(frame(0), RATE, 0);

  const before = drainOne(session, 0);
  const beforeLast = sample(before.output, CHUNK - 1);
  assert.ok(Math.abs(beforeLast - AMPLITUDE) <= 1);

  // Frame 0 is already audible before this later packet proves that frame 1
  // never arrived. Raw previous-chunk editing is now too late to fix what the
  // listener heard, so the mix-output edge must own the transition to silence.
  session.ingestBacking(frame(CHUNK * 2), RATE, 20);
  assert.deepEqual(session.readBackingEvidence(CHUNK, CHUNK), {
    gapSamples: CHUNK,
    frontierMissingSamples: 0,
    unheaderedSamples: 0,
  });

  const missing = drainOne(session, 20);
  assert.ok(
    Math.abs(sample(missing.output, 0) - beforeLast) <= 1,
    'first newly-proven gap sample must continue the already-emitted song edge',
  );
  assert.equal(
    sample(missing.output, FADE - 1),
    0,
    'late-discovered gap must reach literal silence inside the existing 2 ms budget',
  );
  assert.equal(sample(missing.output, FADE), 0);
  assert.equal(missing.evidence.backingGapSamples, CHUNK);
  assert.equal(missing.evidence.backingStarvedSamples, 0);

  const recovered = drainOne(session, 40);
  assert.equal(sample(recovered.output, 0), 0, 'recovered packet still enters from silence');
  assert.ok(
    Math.abs(sample(recovered.output, FADE) - AMPLITUDE) <= 1,
    'combined raw/output recovery smoothing remains bounded to about 2 ms',
  );
});

test('Backing starvation and late contiguous recovery use the same bounded output edge', () => {
  const session = makeSession();
  session.setBackingExpected(true);
  session.ingestBacking(frame(0), RATE, 0);

  const before = drainOne(session, 0);
  assert.ok(Math.abs(sample(before.output, CHUNK - 1) - AMPLITUDE) <= 1);

  const missing = drainOne(session, 20);
  assert.ok(
    Math.abs(sample(missing.output, 0) - sample(before.output, CHUNK - 1)) <= 1,
    'the first missing Backing sample must continue the prior emitted contribution',
  );
  assert.equal(sample(missing.output, FADE - 1), 0);
  assert.equal(missing.evidence.backingStarvedSamples, CHUNK);
  assert.equal(missing.evidence.backingUnavailableSamples, 0);

  session.ingestBacking(frame(CHUNK), RATE, 40);
  session.ingestBacking(frame(CHUNK * 2), RATE, 40);

  assert.equal(session.health().backingGapMs, 0);
  assert.equal(session.readBacking(CHUNK * 2, 1)[0], AMPLITUDE);

  const recovered = drainOne(session, 40);
  assert.equal(recovered.evidence.backingGapSamples, 0);
  assert.equal(recovered.evidence.backingStarvedSamples, 0);
  assert.equal(sample(recovered.output, 0), 0, 'recovered Backing enters from emitted silence');
  assert.ok(
    Math.abs(sample(recovered.output, FADE - 1) - AMPLITUDE) <= 1,
    'recovered Backing reaches the real waveform inside 2 ms',
  );
  assert.ok(Math.abs(sample(recovered.output, FADE) - AMPLITUDE) <= 1);
});
