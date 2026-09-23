import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AudioSession } from '../src/audio-session.js';
import type { PcmFrame } from '../src/pcm-frame.js';

const RATE = 48_000;
const FRAME_MS = 20;
const FRAME_SAMPLES = Math.round((RATE * FRAME_MS) / 1000);
const PREBUFFER_MS = 400;
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

function maxAdjacentStep(buffers: Buffer[], firstComparedSample = 0) {
  let maximum = 0;
  let maximumAt = -1;
  let maximumFrom = 0;
  let maximumTo = 0;
  let previous: number | null = null;
  let sampleAt = 0;

  for (const buffer of buffers) {
    for (let index = 0; index < buffer.byteLength / 2; index += 1) {
      const current = buffer.readInt16LE(index * 2);
      if (previous !== null && sampleAt >= firstComparedSample) {
        const step = Math.abs(current - previous);
        if (step > maximum) {
          maximum = step;
          maximumAt = sampleAt;
          maximumFrom = previous;
          maximumTo = current;
        }
      }
      previous = current;
      sampleAt += 1;
    }
  }

  return { maximum, maximumAt, maximumFrom, maximumTo };
}

test('seeded limiter and Mic ownership transitions stay output-continuous', () => {
  for (const seed of [0x12345678, 0x9e3779b9, 0xc0ffee, 0x5eed5eed]) {
    const random = seeded(seed);
    const session = new AudioSession({
      sampleRate: RATE,
      frameMs: FRAME_MS,
      prebufferMs: PREBUFFER_MS,
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
    const recentActions: string[] = [];
    let micExpected = true;

    // The fixture intentionally starts with an already-hot sine. Its first
    // derivative is not a runtime transition, so establish one emitted frame
    // before randomized gain/ownership actions begin. The frame0→frame1 join
    // remains inside the invariant.
    session.drain((pcm) => outputs.push(pcm), PREBUFFER_MS, 1);

    for (let outputFrame = 1; outputFrame < 180; outputFrame += 1) {
      const nowMs = PREBUFFER_MS + outputFrame * FRAME_MS;
      const action = random();
      let actionLabel = 'none';

      if (action < 0.20) {
        const gainDb = -6 + Math.round(random() * 42);
        session.setMicGainDb(gainDb);
        actionLabel = `gain:${gainDb}`;
      } else if (action < 0.32) {
        micExpected = !micExpected;
        session.setMicExpected(micExpected);
        actionLabel = `expected:${micExpected}`;
      } else if (action < 0.42 && micExpected) {
        session.retireMicCapture();
        micGeneration += 1;
        micCaptureCursor = RATE;
        actionLabel = `replace:g${micGeneration}`;
        session.ingestMic(
          micFrame(micGeneration, 0, micCaptureCursor),
          RATE,
          nowMs,
        );
      } else if (action < 0.52 && micExpected) {
        session.retireMicCapture();
        micGeneration += 1;
        micCaptureCursor = 0;
        actionLabel = `retire:g${micGeneration}`;
      } else if (action < 0.62 && micExpected && session.micTotalSamples === 0) {
        session.ingestMic(
          micFrame(micGeneration, micCaptureCursor, RATE),
          RATE,
          nowMs,
        );
        micCaptureCursor += RATE;
        actionLabel = `restore:g${micGeneration}`;
      }

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

      recentActions.push(`f${outputFrame}:${actionLabel}`);
      if (recentActions.length > 180) recentActions.shift();
      session.drain((pcm) => outputs.push(pcm), nowMs, 1);
    }

    const health = session.health();
    assert.ok(
      health.limitedSamples > 0,
      `seed 0x${seed.toString(16)} never exercised the limiter`,
    );

    const {
      maximum,
      maximumAt,
      maximumFrom,
      maximumTo,
    } = maxAdjacentStep(outputs, FRAME_SAMPLES);
    const maximumFrame = Math.floor(maximumAt / FRAME_SAMPLES);
    const actionStart = Math.max(0, maximumFrame - 12);
    const actionTrace = recentActions.slice(actionStart, maximumFrame + 1).join(' ');
    assert.ok(
      maximum < MAX_AUDIBLE_STEP,
      `limiter/ownership seed 0x${seed.toString(16)} emitted ${maximumFrom} -> ${maximumTo} (step ${maximum}) at sample ${maximumAt}, frame ${maximumFrame}, offset ${maximumAt % FRAME_SAMPLES}; recent ${actionTrace}`,
    );
  }
});
