import assert from 'node:assert/strict';
import test from 'node:test';

import { AudioSession } from '../src/audio-session.js';
import type { PcmFrame } from '../src/pcm-frame.js';

const RATE = 48_000;
const FRAME_MS = 20;
const FRAME_SAMPLES = Math.round((RATE * FRAME_MS) / 1000);
const DECLICK_MS = 2;
const DECLICK_SAMPLES = Math.round((RATE * DECLICK_MS) / 1000);
const MAX_SOURCE_SPAN = 24_000;

// A full +12k -> -12k source replacement spread across the production 2 ms
// edge taper changes by about 253/sample. Allow ~6x that theoretical slope so
// overlapping bounded transitions have room, while a hard splice (12k-24k)
// still fails by an order of magnitude.
const MAX_ADJACENT_STEP = Math.ceil(MAX_SOURCE_SPAN / Math.max(1, DECLICK_SAMPLES - 1)) * 6;

type Source = 'mic' | 'backing';

type ScenarioResult = {
  maxStep: number;
  maxAt: number;
  maxFrom: number;
  maxTo: number;
  emittedSamples: number;
  emittedFrameIndex: number;
  events: Record<string, number>;
  trace: string[];
};

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function constantPcm(samples: number, value: number) {
  const buffer = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    buffer.writeInt16LE(value, index * 2);
  }
  return buffer;
}

function sourceFrame(
  generation: number,
  firstSampleIndex: number,
  samples: number,
  value: number,
): PcmFrame {
  return {
    generation,
    firstSampleIndex,
    pcm: constantPcm(samples, value),
  };
}

function makeSession(source: Source) {
  const session = new AudioSession({
    sampleRate: RATE,
    frameMs: FRAME_MS,
    prebufferMs: 40,
    backingGain: 1,
    retentionMs: 5_000,
  });
  if (source === 'mic') {
    session.setMicGainDb(0);
    session.setMicExpected(true);
  } else {
    session.setBackingExpected(true);
  }
  session.start(0);
  return session;
}

function runScenario(source: Source, seed: number): ScenarioResult {
  const random = seededRandom(seed);
  const session = makeSession(source);
  const events: Record<string, number> = {
    continuation: 0,
    gap: 0,
    generationRestart: 0,
    rateRestart: 0,
    retire: 0,
    doubleRestart: 0,
    gainChange: 0,
  };

  let generation = 1;
  let sourceRate = RATE;
  let sourceIndex = 0;
  let level = 12_000;
  let replacementPending = false;
  let emittedFrames = 0;
  let emittedSamples = 0;
  let previous: number | null = null;
  let maxStep = 0;
  let maxAt = -1;
  let maxFrom = 0;
  let maxTo = 0;
  let emittedFrameIndex = -1;
  const trace: string[] = [];
  let maxTrace: string[] = [];

  const remember = (message: string) => {
    trace.push(message);
    if (trace.length > 12) trace.shift();
  };

  const frameSamples = () => Math.round((sourceRate * FRAME_MS) / 1000);

  const ingestOne = (nowMs: number) => {
    const samples = frameSamples();
    const firstSampleIndex = sourceIndex;
    const frame = sourceFrame(generation, firstSampleIndex, samples, level);
    sourceIndex += samples;
    const result = source === 'mic'
      ? session.ingestMic(frame, sourceRate, nowMs)
      : session.ingestBacking(frame, sourceRate, nowMs);
    remember(
      `ingest t=${nowMs} gen=${generation} rate=${sourceRate} src=${firstSampleIndex}+${samples} level=${level} -> start=${result.start} samples=${result.samples.length} restart=${result.captureRestarted}`,
    );
  };

  const retire = () => {
    if (source === 'mic') session.retireMicCapture();
    else session.retireBackingCapture();
    remember(`retire gen=${generation} rate=${sourceRate} src=${sourceIndex} level=${level}`);
  };

  const record = (output: Buffer) => {
    emittedFrames += 1;
    emittedFrameIndex += 1;
    // Let startup + limiter lookahead settle before enforcing the seam
    // invariant. All randomized transitions begin after this warm-up too.
    const enforce = emittedFrames > 3;
    for (let index = 0; index < output.byteLength / 2; index += 1) {
      const current = output.readInt16LE(index * 2);
      if (enforce && previous !== null) {
        const step = Math.abs(current - previous);
        if (step > maxStep) {
          maxStep = step;
          maxAt = emittedSamples + index;
          maxFrom = previous;
          maxTo = current;
          remember(
            `MAX outputFrame=${emittedFrameIndex} offset=${index} absolute=${maxAt} ${previous}->${current} step=${step}`,
          );
          maxTrace = [...trace];
        }
      }
      previous = current;
    }
    emittedSamples += output.byteLength / 2;
  };

  const totalSteps = 84;
  for (let step = 0; step < totalSteps; step += 1) {
    const nowMs = step * FRAME_MS;

    // Six stable frames warm the mixer and limiter before the generated seam
    // sequence begins.
    if (step < 6) {
      ingestOne(nowMs);
      events.continuation += 1;
    } else if (replacementPending) {
      generation = (generation + 1) >>> 0;
      sourceRate = (random() & 1) === 0 ? RATE : 44_100;
      sourceIndex = 0;
      level = -level;
      ingestOne(nowMs);
      replacementPending = false;
      events.generationRestart += 1;
    } else {
      if (source === 'mic' && random() % 7 === 0) {
        const gains = [-6, 0, 6] as const;
        session.setMicGainDb(gains[random() % gains.length]!);
        events.gainChange += 1;
      }

      switch (random() % 6) {
        case 0: {
          ingestOne(nowMs);
          events.continuation += 1;
          break;
        }
        case 1: {
          // Captured time advances, but one positioned frame never reaches
          // Relay. The next packet will expose the exact hole.
          const skipped = frameSamples();
          remember(
            `gap t=${nowMs} gen=${generation} rate=${sourceRate} src=${sourceIndex}+${skipped} level=${level}`,
          );
          sourceIndex += skipped;
          events.gap += 1;
          break;
        }
        case 2: {
          generation = (generation + 1) >>> 0;
          sourceIndex = 0;
          level = -level;
          ingestOne(nowMs);
          events.generationRestart += 1;
          break;
        }
        case 3: {
          // Same wire generation with a contradictory source rate is also a
          // fresh capture clock and must own an audible restart seam.
          sourceRate = sourceRate === RATE ? 44_100 : RATE;
          sourceIndex = 0;
          level = -level;
          ingestOne(nowMs);
          events.rateRestart += 1;
          break;
        }
        case 4: {
          // Bind-time replacement: old timeline disappears immediately; the
          // replacement arrives on the next 20 ms step.
          retire();
          replacementPending = true;
          events.retire += 1;
          break;
        }
        case 5: {
          // Two capture clocks arrive before this mix frame drains. Keep the
          // intermediate segment short enough to exercise overlapping edge
          // ownership rather than only well-separated transitions.
          const oldLevel = level;
          generation = (generation + 1) >>> 0;
          sourceIndex = 0;
          level = -oldLevel;
          ingestOne(nowMs);

          generation = (generation + 1) >>> 0;
          sourceIndex = 0;
          level = oldLevel > 0 ? 6_000 : -6_000;
          ingestOne(nowMs + 1);
          events.doubleRestart += 1;
          break;
        }
      }
    }

    session.drain((output) => record(output), nowMs, 1);
  }

  // Stop feeding the source and let the audible frontier taper to silence.
  for (let tail = 0; tail < 6; tail += 1) {
    const nowMs = (totalSteps + tail) * FRAME_MS;
    session.drain((output) => record(output), nowMs, 1);
  }

  return {
    maxStep,
    maxAt,
    maxFrom,
    maxTo,
    emittedSamples,
    emittedFrameIndex,
    events,
    trace: maxTrace.length > 0 ? maxTrace : [...trace],
  };
}

for (const source of ['mic', 'backing'] as const) {
  test(`${source} seeded seam combinations stay inside the bounded output-step invariant`, () => {
    const seeds = [
      0x12345678,
      0x9e3779b9,
      0xdeadbeef,
      0x00c0ffee,
      0x13579bdf,
      0x2468ace0,
    ];
    const totals: Record<string, number> = {};

    for (const seed of seeds) {
      const result = runScenario(source, seed);
      for (const [event, count] of Object.entries(result.events)) {
        totals[event] = (totals[event] ?? 0) + count;
      }
      assert.ok(
        result.maxStep <= MAX_ADJACENT_STEP,
        `${source} seed 0x${seed.toString(16)} emitted a ${result.maxStep}-sample splice at ${result.maxAt} (${result.maxFrom}->${result.maxTo}); limit=${MAX_ADJACENT_STEP}; recent=\n${result.trace.join('\n')}`,
      );
      assert.ok(result.emittedSamples > FRAME_SAMPLES * 20);
    }

    for (const event of ['gap', 'generationRestart', 'rateRestart', 'retire', 'doubleRestart']) {
      assert.ok((totals[event] ?? 0) > 0, `fixture must exercise ${source} ${event}`);
    }
    if (source === 'mic') {
      assert.ok((totals.gainChange ?? 0) > 0, 'fixture must exercise live Mic gain ramps');
    }
  });
}
