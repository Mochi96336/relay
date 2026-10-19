import { TakeController } from '../../src/take-controller.js';

const RATE = 48_000;

/** A Take controller on `directory` with no storage limits, and a promise for when its library is ready. */
export function waitForReady(directory: string) {
  let resolveReady: (() => void) | null = null;
  const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
  const controller = new TakeController({
    directory,
    sampleRate: RATE,
    storagePolicy: { maxBytes: 0, maxAgeMs: 0, minFreeBytes: 0 },
    onStorageError: (error) => { throw error; },
    onChange: (status) => {
      if (status.lifecycle === 'ready') resolveReady?.();
    },
  });
  return { controller, ready };
}
