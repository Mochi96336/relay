import { Worker } from 'node:worker_threads';

import type { TimingCalibrationAnalysis } from './timing-calibration.js';

type TimingCalibrationWorkerMessage =
  | { ok: true; result: TimingCalibrationAnalysis }
  | { ok: false; error: string };

/**
 * Maximum wall time for one CPU-heavy timing analysis.
 *
 * Capture collection has its own timeout in CalibrationSession. This bound is
 * deliberately separate: once a complete window has been handed to a worker,
 * a worker that never posts a result must not leave the product permanently at
 * 100% collecting or retain CPU/resources forever.
 */
export const DEFAULT_TIMING_CALIBRATION_ANALYSIS_TIMEOUT_MS = 20_000;

/** Runs the CPU-heavy matcher away from the mixer and transport timers. */
export function analyzeTimingCalibrationInWorker(
  micSamples: Int16Array,
  backingSamples: Int16Array,
  sampleRate: number,
  maxLagMs?: number,
  signal?: AbortSignal,
  timeoutMs = DEFAULT_TIMING_CALIBRATION_ANALYSIS_TIMEOUT_MS,
): Promise<TimingCalibrationAnalysis> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new RangeError('Timing calibration analysis timeout must be positive.'));
  }

  // These copies are transferred, not cloned again by structured clone. The
  // caller retains its own views while the worker owns these disposable buffers.
  const mic = new Int16Array(micSamples);
  const backing = new Int16Array(backingSamples);

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Timing calibration analysis was cancelled.'));
      return;
    }

    const worker = new Worker(new URL('./timing-calibration-worker-entry.mjs', import.meta.url), {
      workerData: {
        micBuffer: mic.buffer,
        backingBuffer: backing.buffer,
        sampleRate,
        maxLagMs,
      },
      transferList: [mic.buffer, backing.buffer],
    });
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      void worker.terminate();
      reject(new Error(`Timing calibration analysis timed out after ${timeoutMs} ms.`));
    }, timeoutMs);
    timeout.unref?.();

    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      void worker.terminate();
      reject(new Error('Timing calibration analysis was cancelled.'));
    };
    signal?.addEventListener('abort', abort, { once: true });

    worker.once('message', (message: TimingCalibrationWorkerMessage) => {
      if (settled) return;
      settled = true;
      cleanup();
      void worker.terminate();
      if (message.ok) resolve(message.result);
      else reject(new Error(message.error));
    });
    worker.once('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    worker.once('exit', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Timing calibration worker exited with code ${code}.`));
    });
  });
}
