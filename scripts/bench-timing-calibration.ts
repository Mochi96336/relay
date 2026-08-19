import { performance } from 'node:perf_hooks';

import { analyzeTimingCalibration } from '../src/timing-calibration.js';
import { laggedPair } from '../test/helpers/harness.js';

const SAMPLE_RATE = 48_000;
const ITERATIONS = 5;

function int16View(buffer: Buffer) {
  return new Int16Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 2);
}

const { mic, backing } = laggedPair(6, SAMPLE_RATE, 340);
const micSamples = int16View(mic);
const backingSamples = int16View(backing);

// Keep fixture construction and one-time JIT/module warmup out of the measured
// runs. This benchmark is evidence for analyzer wall time, not a CI threshold.
analyzeTimingCalibration(micSamples, backingSamples, SAMPLE_RATE, 2_500);

const durations: number[] = [];
for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
  const started = performance.now();
  const result = analyzeTimingCalibration(micSamples, backingSamples, SAMPLE_RATE, 2_500);
  const elapsed = performance.now() - started;
  durations.push(elapsed);
  console.log(
    `run ${iteration + 1}: ${elapsed.toFixed(1)} ms ` +
    `(lag ${result.micLagMs} ms, confidence ${result.confidence.toFixed(2)})`,
  );
}

const sorted = [...durations].sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)];
const minimum = sorted[0];
const maximum = sorted[sorted.length - 1];
console.log(
  `summary: median ${median.toFixed(1)} ms · ` +
  `min ${minimum.toFixed(1)} ms · max ${maximum.toFixed(1)} ms`,
);
