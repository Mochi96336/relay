import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { MIC_CAPTURE_CHANGED_TIMING_REASON } from '../src/relay-mic-timing-invalidation-coordinator.js';

const publisher = readFileSync(
  new URL('../src/relay-publisher-activation-coordinator.ts', import.meta.url),
  'utf8',
);
const invalidation = readFileSync(
  new URL('../src/relay-mic-timing-invalidation-coordinator.ts', import.meta.url),
  'utf8',
);

test('Mic capture replacement timing semantics use one shared reason authority', () => {
  assert.equal(MIC_CAPTURE_CHANGED_TIMING_REASON, 'Microphone capture changed.');

  assert.match(
    publisher,
    /import \{ MIC_CAPTURE_CHANGED_TIMING_REASON \} from '\.\/relay-mic-timing-invalidation-coordinator\.js';/,
  );
  assert.match(
    publisher,
    /options\.invalidateTiming\(MIC_CAPTURE_CHANGED_TIMING_REASON\)/,
  );
  assert.doesNotMatch(publisher, /['"]Microphone capture changed\.['"]/);

  assert.match(
    invalidation,
    /export const MIC_CAPTURE_CHANGED_TIMING_REASON = 'Microphone capture changed\.' as const;/,
  );
  assert.match(
    invalidation,
    /message === MIC_CAPTURE_CHANGED_TIMING_REASON/,
  );
});
