import { parentPort, workerData } from 'node:worker_threads';

import { analyzeTimingCalibration } from './timing-calibration.js';

type TimingCalibrationWorkerInput = {
  micBuffer: ArrayBuffer;
  backingBuffer: ArrayBuffer;
  sampleRate: number;
  maxLagMs?: number;
};

const input = workerData as TimingCalibrationWorkerInput;

try {
  const mic = new Int16Array(input.micBuffer);
  const backing = new Int16Array(input.backingBuffer);
  const result = input.maxLagMs === undefined
    ? analyzeTimingCalibration(mic, backing, input.sampleRate)
    : analyzeTimingCalibration(mic, backing, input.sampleRate, input.maxLagMs);
  parentPort?.postMessage({ ok: true, result });
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}
