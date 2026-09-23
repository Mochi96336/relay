import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AudioSession } from '../src/audio-session.js';
import type { PcmFrame } from '../src/pcm-frame.js';

const RATE = 48_000;
const FRAME_MS = 20;
const FRAME_SAMPLES = Math.round((RATE * FRAME_MS) / 1000);
const TONE_HZ = 997;
const TONE_AMPLITUDE = 8_000;
const MAX_AUDIBLE_STEP = 3_000;
const PREBUFFER_MS = 600;

function pcmTone(firstSample: number, count: number) {
  const pcm = Buffer.alloc(count * 2);
  for (let index = 0; index < count; index += 1) {
    const sampleIndex = firstSample + index;
    const value = Math.round(
      TONE_AMPLITUDE * Math.sin((2 * Math.PI * TONE_HZ * sampleIndex) / RATE),
    );
    pcm.writeInt16LE(value, index * 2);
  }
  return pcm;
}

function frame(firstSampleIndex: number, count: number): PcmFrame {
  return {
    generation: 1,
    firstSampleIndex,
    pcm: pcmTone(firstSampleIndex, count),
  };
}

function makeSession() {
  const session = new AudioSession({
    sampleRate: RATE,
    frameMs: FRAME_MS,
    prebufferMs: PREBUFFER_MS,
    backingGain: 0.65,
    retentionMs: 3_000,
    backingRetentionMs: 1_000,
  });
  session.setMicGainDb(0);
  session.setMicExpected(true);
  session.start(0);
  return session;
}

function maxAdjacentStep(buffers: Buffer[]) {
  let maximum = 0;
  let previous: number | null = null;
  let maximumAt = -1;
  let sampleAt = 0;

  for (const buffer of buffers) {
    for (let index = 0; index < buffer.byteLength / 2; index += 1) {
      const current = buffer.readInt16LE(index * 2);
      if (previous !== null) {
        const step = Math.abs(current - previous);
        if (step > maximum) {
          maximum = step;
          maximumAt = sampleAt;
        }
      }
      previous = current;
      sampleAt += 1;
    }
  }

  return { maximum, maximumAt };
}

function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

test('seeded live alignment authority changes never splice a continuous Mic tone', () => {
  for (const seed of [0x12345678, 0x9e3779b9, 0xc0ffee, 0x5eed5eed]) {
    const random = seeded(seed);
    const session = makeSession();
    session.setAlignment({ calibratedMicLagMs: 100 });
    session.ingestMic(frame(0, RATE * 6), RATE, 0);

    const outputs: Buffer[] = [];
    for (let outputFrame = 0; outputFrame < 120; outputFrame += 1) {
      const action = random();

      if (action < 0.18) {
        const target = 40 + Math.round(random() * 200);
        session.setAlignment({ calibratedMicLagMs: target });
      } else if (action < 0.46) {
        const target = 40 + Math.round(random() * 200);
        session.slewCalibratedMicLagTo(target);
      } else if (action < 0.58) {
        const fineTuneMs = -30 + Math.round(random() * 60);
        session.setAlignment({ fineTuneMs });
      }

      session.drain((pcm) => outputs.push(pcm), PREBUFFER_MS + outputFrame * FRAME_MS, 1);
    }

    const { maximum, maximumAt } = maxAdjacentStep(outputs);
    assert.ok(
      maximum < MAX_AUDIBLE_STEP,
      `alignment seed 0x${seed.toString(16)} emitted a ${maximum}-sample splice at ${maximumAt}`,
    );
  }
});

test('real Mic frontier correction acquire and release stays continuous on a tone', () => {
  const session = makeSession();
  session.setAlignment({ networkCompensationMs: 140 });

  // Begin with only 100 ms of capture. The requested +140 ms live read head
  // cannot fit, so the normal production frontier policy must acquire a hold.
  let frontier = Math.round(RATE * 0.1);
  session.ingestMic(frame(0, frontier), RATE, 0);

  const outputs: Buffer[] = [];
  session.drain((pcm) => outputs.push(pcm), PREBUFFER_MS, 1);
  const acquiredCorrectionMs = session.micFrontierCorrectionMs;
  assert.ok(
    acquiredCorrectionMs > 0,
    `fixture must acquire a real frontier correction, saw ${acquiredCorrectionMs} ms`,
  );

  // Catch the source up faster than realtime with phase-continuous PCM. This
  // makes production updateMicFrontierCorrection() release the hold through its
  // normal one-percent source-read slew instead of a test-only state mutation.
  for (let outputFrame = 1; outputFrame < 80; outputFrame += 1) {
    const arrivalSamples = FRAME_SAMPLES * 2;
    session.ingestMic(frame(frontier, arrivalSamples), RATE, outputFrame * FRAME_MS);
    frontier += arrivalSamples;
    session.drain((pcm) => outputs.push(pcm), PREBUFFER_MS + outputFrame * FRAME_MS, 1);
  }

  assert.ok(
    session.micFrontierCorrectionMs < acquiredCorrectionMs,
    `frontier correction should release after catch-up: ${acquiredCorrectionMs} -> ${session.micFrontierCorrectionMs} ms`,
  );

  const { maximum, maximumAt } = maxAdjacentStep(outputs);
  assert.ok(
    maximum < MAX_AUDIBLE_STEP,
    `frontier acquire/release emitted a ${maximum}-sample splice at ${maximumAt}`,
  );
});
