import { parentPort } from 'node:worker_threads';
import { register } from 'node:module';

// The full node --test suite and the focused Choir runner do not always
// propagate the parent's tsx loader to a new Worker in the same way.
// Register explicitly in THIS thread before dynamically importing .ts.
// Static imports are resolved before module body execution, so they cannot
// safely be used for the analyzer here.
register('tsx/esm', import.meta.url);
const { analyzeTimingCalibration } = await import('./timing-calibration.ts');

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
