import { parentPort, workerData } from 'node:worker_threads';

import {
  analyzeTimingCalibration,
  analyzeTimingCalibrationShadow,
  diagnoseTimingCalibrationFailure,
  type TimingCalibrationFailureDiagnostics,
  type TimingCalibrationShadowAnalysis,
} from './timing-calibration.js';

type TimingCalibrationWorkerInput = {
  micBuffer: ArrayBuffer;
  backingBuffer: ArrayBuffer;
  sampleRate: number;
  maxLagMs?: number;
  shadowLowLevel?: boolean;
};

type TimingCalibrationWorkerFailure = {
  ok: false;
  error: string;
  failureDiagnostics?: TimingCalibrationFailureDiagnostics;
  shadow?: TimingCalibrationShadowAnalysis | null;
};

const input = workerData as TimingCalibrationWorkerInput;
const mic = new Int16Array(input.micBuffer);
const backing = new Int16Array(input.backingBuffer);

try {
  const result = input.maxLagMs === undefined
    ? analyzeTimingCalibration(mic, backing, input.sampleRate)
    : analyzeTimingCalibration(mic, backing, input.sampleRate, input.maxLagMs);
  parentPort?.postMessage({ ok: true, result });
} catch (error) {
  const shadow = input.shadowLowLevel
    ? input.maxLagMs === undefined
      ? analyzeTimingCalibrationShadow(mic, backing, input.sampleRate)
      : analyzeTimingCalibrationShadow(mic, backing, input.sampleRate, input.maxLagMs)
    : null;
  const failureDiagnostics = input.shadowLowLevel
    ? input.maxLagMs === undefined
      ? diagnoseTimingCalibrationFailure(error, mic, backing, input.sampleRate)
      : diagnoseTimingCalibrationFailure(error, mic, backing, input.sampleRate, input.maxLagMs)
    : undefined;
  const message: TimingCalibrationWorkerFailure = {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    failureDiagnostics,
    shadow,
  };
  parentPort?.postMessage(message);
}
