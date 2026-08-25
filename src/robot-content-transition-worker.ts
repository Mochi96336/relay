import { parentPort, workerData } from 'node:worker_threads';

import {
  compareRobotContentHypotheses,
  estimateRobotContentRawLag,
} from './robot-content-transition.js';

type AnchorInput = {
  operation: 'anchor';
  micBuffer: ArrayBuffer;
  backingBuffer: ArrayBuffer;
  sampleRate: number;
  maxLagMs: number;
};

type CompareInput = {
  operation: 'compare';
  backingBuffer: ArrayBuffer;
  preMicBuffer: ArrayBuffer;
  postMicBuffer: ArrayBuffer;
  sampleRate: number;
};

type RobotContentTransitionWorkerInput = AnchorInput | CompareInput;

const input = workerData as RobotContentTransitionWorkerInput;

try {
  const result = input.operation === 'anchor'
    ? estimateRobotContentRawLag(
      new Int16Array(input.micBuffer),
      new Int16Array(input.backingBuffer),
      input.sampleRate,
      input.maxLagMs,
    )
    : compareRobotContentHypotheses(
      new Int16Array(input.backingBuffer),
      new Int16Array(input.preMicBuffer),
      new Int16Array(input.postMicBuffer),
      input.sampleRate,
    );
  parentPort?.postMessage({ ok: true, result });
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}
