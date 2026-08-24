import { Worker } from 'node:worker_threads';

import type { TimingCalibrationAnalysis } from './timing-calibration.js';

type TimingCalibrationWorkerMessage =
  | { ok: true; result: TimingCalibrationAnalysis }
  | { ok: false; error: string };

/** Runs the CPU-heavy matcher away from the mixer and transport timers. */
export function analyzeTimingCalibrationInWorker(
  micSamples: Int16Array,
  backingSamples: Int16Array,
  sampleRate: number,
  maxLagMs?: number,
  signal?: AbortSignal,
): Promise<TimingCalibrationAnalysis> {
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

    const cleanup = () => signal?.removeEventListener('abort', abort);
    const abort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      void worker.terminate();
      reject(new Error('Timing calibration analysis was cancelled.'));
    };
    signal?.addEventListener('abort', abort, { once: true });

    worker.once('message', (message: TimingCalibrationWorkerMessage) => {
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
