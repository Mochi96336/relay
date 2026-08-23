import { Worker } from 'node:worker_threads';

import type {
  TimingCalibrationAnalysis,
  TimingCalibrationFailureDiagnostics,
  TimingCalibrationShadowAnalysis,
} from './timing-calibration.js';

type TimingCalibrationWorkerMessage =
  | { ok: true; result: TimingCalibrationAnalysis }
  | {
      ok: false;
      error: string;
      failureDiagnostics?: TimingCalibrationFailureDiagnostics;
      shadow?: TimingCalibrationShadowAnalysis | null;
    };

function failureLogPayload(
  failure: TimingCalibrationFailureDiagnostics,
  error: string,
) {
  return {
    source: 'worker-failure',
    authoritative: false,
    failureStage: failure.failureStage,
    error,
    micLevelDbfs: failure.micLevelDbfs === null ? null : Number(failure.micLevelDbfs.toFixed(1)),
    backingLevelDbfs: failure.backingLevelDbfs === null ? null : Number(failure.backingLevelDbfs.toFixed(1)),
    bestLagMs: failure.bestLagMs,
    bestScore: failure.bestScore === null ? null : Number(failure.bestScore.toFixed(3)),
    runnerUpLagMs: failure.runnerUpLagMs,
    runnerUpScore: failure.runnerUpScore === null ? null : Number(failure.runnerUpScore.toFixed(3)),
    peakMargin: failure.peakMargin === null ? null : Number(failure.peakMargin.toFixed(3)),
    activeBands: failure.activeBands,
    supportingBands: failure.supportingBands,
    segmentLagsMs: failure.segmentLagsMs,
    segmentCorrelations: failure.segmentCorrelations.map((score) => Number(score.toFixed(3))),
  };
}

function shadowLogPayload(shadow: TimingCalibrationShadowAnalysis) {
  const diagnostics = shadow.result?.diagnostics;
  return {
    reason: shadow.reason,
    authoritative: false,
    micLevelDbfs: Number(shadow.micLevelDbfs.toFixed(1)),
    backingLevelDbfs: Number(shadow.backingLevelDbfs.toFixed(1)),
    wouldPass: shadow.wouldPass,
    failureStage: shadow.failureStage,
    error: shadow.error,
    bestLagMs: diagnostics?.bestLagMs ?? null,
    bestScore: diagnostics ? Number(diagnostics.bestScore.toFixed(3)) : null,
    runnerUpLagMs: diagnostics?.runnerUpLagMs ?? null,
    runnerUpScore: diagnostics?.runnerUpScore === null || diagnostics?.runnerUpScore === undefined
      ? null
      : Number(diagnostics.runnerUpScore.toFixed(3)),
    peakMargin: diagnostics?.peakMargin === null || diagnostics?.peakMargin === undefined
      ? null
      : Number(diagnostics.peakMargin.toFixed(3)),
    activeBands: diagnostics?.activeBands ?? [],
    supportingBands: diagnostics?.supportingBands ?? [],
    segmentLagsMs: shadow.result?.segmentLagsMs ?? [],
    segmentCorrelations: shadow.result?.segmentCorrelations.map(
      (score) => Number(score.toFixed(3)),
    ) ?? [],
  };
}

/** Runs the CPU-heavy matcher away from the mixer and transport timers. */
export function analyzeTimingCalibrationInWorker(
  micSamples: Int16Array,
  backingSamples: Int16Array,
  sampleRate: number,
  maxLagMs?: number,
  signal?: AbortSignal,
  onShadow?: (shadow: TimingCalibrationShadowAnalysis) => void,
  shadowLowLevel = process.env.RELAY_CALIBRATION_SHADOW_LOW_LEVEL === '1',
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
        shadowLowLevel,
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
      if (message.ok) {
        resolve(message.result);
        return;
      }

      if (shadowLowLevel && message.failureDiagnostics) {
        console.log(
          `[calibration-shadow] ${JSON.stringify(failureLogPayload(message.failureDiagnostics, message.error))}`,
        );
      }
      if (message.shadow) {
        if (onShadow) onShadow(message.shadow);
        else if (shadowLowLevel) {
          console.log(`[calibration-shadow] ${JSON.stringify(shadowLogPayload(message.shadow))}`);
        }
      }
      // Shadow evidence is observational only. The authoritative promise still
      // rejects exactly as it did before, so CalibrationSession cannot consume
      // a low-level result for agreement, provisional state or promotion.
      reject(new Error(message.error));
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
