import { parentPort } from 'node:worker_threads';
import { tsImport } from 'tsx/esm/api';

// Scoped TypeScript import in THIS worker. Do not rely on inherited
// --import flags, nor call node:module.register('tsx/esm'): that direct
// loader invocation is rejected by tsx as a legacy --loader path.
// This one-time import preserves the canonical production analyzer.
const { analyzeTimingCalibration } = await tsImport(
  './timing-calibration.ts', import.meta.url,
);

// Runs outside the Relay event loop. No sockets, participants, epochs or
// authorization exist in this worker: it only calculates from trusted copies.
if (!parentPort) throw new Error('Choir Content worker requires parentPort');

parentPort.on('message', (job) => {
  if (!job || !Number.isSafeInteger(job.id)
    || job.sampleRate !== 48_000
    || !(job.mic instanceof Int16Array)
    || !(job.backing instanceof Int16Array)
    || job.mic.length !== 6 * job.sampleRate
    || job.backing.length !== 6 * job.sampleRate) {
    parentPort.postMessage({ id: job?.id, ok: false, reason: 'invalid-worker-input' });
    return;
  }
  try {
    const result = analyzeTimingCalibration(
      job.mic, job.backing, job.sampleRate,
    );
    parentPort.postMessage({
      id: job.id, ok: true,
      micLagMs: result.micLagMs, confidence: result.confidence,
    });
  } catch (error) {
    parentPort.postMessage({
      id: job.id, ok: false,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
});
