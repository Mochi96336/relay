import { Worker } from 'node:worker_threads';

import type {
  RobotContentTransitionAnchor,
  RobotContentTransitionComparison,
} from './robot-content-transition.js';

type RobotContentTransitionWorkerMessage<T> =
  | { ok: true; result: T }
  | { ok: false; error: string };

function runRobotContentTransitionWorker<T>(
  workerData: Record<string, unknown>,
  transferList: ArrayBuffer[],
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Robot content transition analysis was cancelled.'));
      return;
    }

    const worker = new Worker(new URL('./robot-content-transition-worker-entry.mjs', import.meta.url), {
      workerData,
      transferList,
    });
    let settled = false;

    const cleanup = () => signal?.removeEventListener('abort', abort);
    const abort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      void worker.terminate();
      reject(new Error('Robot content transition analysis was cancelled.'));
    };
    signal?.addEventListener('abort', abort, { once: true });

    worker.once('message', (message: RobotContentTransitionWorkerMessage<T>) => {
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
      reject(new Error(`Robot content transition worker exited with code ${code}.`));
    });
  });
}

export function estimateRobotContentRawLagInWorker(
  micSamples: Int16Array,
  backingSamples: Int16Array,
  sampleRate: number,
  maxLagMs: number,
  signal?: AbortSignal,
): Promise<RobotContentTransitionAnchor | null> {
  const mic = new Int16Array(micSamples);
  const backing = new Int16Array(backingSamples);
  return runRobotContentTransitionWorker<RobotContentTransitionAnchor | null>({
    operation: 'anchor',
    micBuffer: mic.buffer,
    backingBuffer: backing.buffer,
    sampleRate,
    maxLagMs,
  }, [mic.buffer, backing.buffer], signal);
}

export function compareRobotContentHypothesesInWorker(
  backingSamples: Int16Array,
  preMicSamples: Int16Array,
  postMicSamples: Int16Array,
  sampleRate: number,
  signal?: AbortSignal,
): Promise<RobotContentTransitionComparison> {
  const backing = new Int16Array(backingSamples);
  const preMic = new Int16Array(preMicSamples);
  const postMic = new Int16Array(postMicSamples);
  return runRobotContentTransitionWorker<RobotContentTransitionComparison>({
    operation: 'compare',
    backingBuffer: backing.buffer,
    preMicBuffer: preMic.buffer,
    postMicBuffer: postMic.buffer,
    sampleRate,
  }, [backing.buffer, preMic.buffer, postMic.buffer], signal);
}
