import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decideBootProbeRunIdentity,
  type BootProbeRunIdentityInput,
} from '../src/boot-probe-run-identity-policy.js';

function facts(
  overrides: Partial<BootProbeRunIdentityInput> = {},
): BootProbeRunIdentityInput {
  return {
    sessionCurrent: true,
    captureGenerationMatches: true,
    ...overrides,
  };
}

test('stale session identity wins before capture generation', () => {
  assert.deepEqual(decideBootProbeRunIdentity(facts({
    sessionCurrent: false,
    captureGenerationMatches: false,
  })), { kind: 'abandon', reason: 'session' });
});

test('current session with stale capture generation is abandoned', () => {
  assert.deepEqual(decideBootProbeRunIdentity(facts({
    captureGenerationMatches: false,
  })), { kind: 'abandon', reason: 'capture-generation' });
});

test('matching session and capture generation keep the run current', () => {
  assert.deepEqual(decideBootProbeRunIdentity(facts()), { kind: 'current' });
});
