import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AudioSession } from '../src/audio-session.js';
import type { PcmFrame } from '../src/pcm-frame.js';

const RATE = 48_000;
const FRAME_MS = 20;
const FRAME_SAMPLES = Math.round((RATE * FRAME_MS) / 1000);
const MIC_HZ = 220;
const MIC_AMPLITUDE = 12_000;
const BACKING_AMPLITUDE = 6_000;
const MAX_AUDIBLE_STEP = 3_000;

function tone(
  firstSample: number,
  count: number,
  hz: number,
  amplitude: number,
) {
  const pcm = Buffer.alloc(count * 2);
  for (let index = 0; index < count; index += 1) {
    const sampleIndex = firstSample + index;
    const value = Math.round(
      amplitude * Math.sin((2 * Math.PI * hz * sampleIndex) / RATE),
    );
    pcm.writeInt16LE(value, index * 2);
  }
  return pcm;
}

function micFrame(
  generation: number,
  firstSampleIndex: number,
  count: number,
): PcmFrame {
  return {
    generation,
    firstSampleIndex,
    pcm: tone(firstSampleIndex, count, MIC_HZ, MIC_AMPLITUDE),
  };
}

function backingFrame(firstSampleIndex: number, count: number): PcmFrame {
  return {
    generation: 1,
    firstSampleIndex,
    pcm: tone(firstSampleIndex, count, 110, BACKING_AMPLITUDE),
  };
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

function maxAdjacentStep(buffers: Buffer[]) {
  let maximum = 0;
  let maximumAt = -1;
  let previous: number | null = null;
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

test('seeded limiter and Mic ownership transitions stay output-continuous', () => {
  for (const seed of [0x12345678, 0x9e3779b9, 0xc0ffee, 0x5eed5eed]) {
    const random = seeded(seed);
    const session = new AudioSession({
      sampleRate: RATE,
      frameMs: FRAME_MS,
      prebufferMs: 0,
      backingGain: 0.65,
      retentionMs: 3_000,
      backingRetentionMs: 3_000,
    });

    session.setMicExpected(true);
    session.setBackingExpected(true);
    session.setMicGainDb(24);
    session.start(0);

    session.ingestBacking(
      backingFrame(0, RATE * 8),
      RATE,
      0,
    );

    let micGeneration = 1;
    let micCaptureCursor = RATE * 2;
    session.ingestMic(
      micFrame(micGeneration, 0, micCaptureCursor),
      RATE,
      0,
    );

    const outputs: Buffer[] = [];
    let micExpected = true;

    for (let outputFrame = 0; outputFrame < 180; outputFrame += 1) {
      const nowMs = outputFrame * FRAME_MS;
      const action = random();

      if (action < 0.20) {
        // Force both limiter attack and release while the gain ramp itself must
        // remain continuous.
        session.setMicGainDb(-6 + Math.round(random() * 42));
      } else if (action < 0.32) {
        micExpected = !micExpected;
        session.setMicExpected(micExpected);
      } else if (action < 0.42 && micExpected) {
        // A semantic capture replacement clears old PCM, but the mixer must
        // retain the last audible contribution and de-click the new generation.
        session.retireMicCapture();
        micGeneration += 1;
        micCaptureCursor = RATE;
        session.ingestMic(
          micFrame(micGeneration, 0, micCaptureCursor),
          RATE,
          nowMs,
        );
      } else if (action < 0.52 && micExpected) {
        // Let the current capture briefly run out, then re-anchor a new
        // generation. This composes limiter release with source-edge recovery.
        session.retireMicCapture();
        micGeneration += 1;
        micCaptureCursor = 0;
      } else if (action < 0.62 && micExpected && session.micTotalSamples === 0) {
        session.ingestMic(
          micFrame(micGeneration, micCaptureCursor, RATE),
          RATE,
          nowMs,
        );
        micCaptureCursor += RATE;
      }

      // Keep live captures comfortably ahead without changing generation.
      if (
        micExpected
        && session.micTotalSamples > 0
        && session.health().micHeadroomMs < 500
      ) {
        session.ingestMic(
          micFrame(micGeneration, micCaptureCursor, RATE),
          RATE,
          nowMs,
        );
        micCaptureCursor += RATE;
      }

      session.drain((pcm) => outputs.push(pcm), nowMs, 1);
    }

    const health = session.health();
    assert.ok(
      health.limitedSamples > 0,
      `seed 0x${seed.toString(16)} never exercised the limiter`,
    );

    const { maximum, maximumAt } = maxAdjacentStep(outputs);
    assert.ok(
      maximum < MAX_AUDIBLE_STEP,
      `limiter/ownership seed 0x${seed.toString(16)} emitted a ${maximum}-sample splice at ${maximumAt}`,
    );
  }
});
