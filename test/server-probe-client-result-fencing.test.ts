import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { functionCode, parseTypeScriptSource } from './support/source-contract.js';

const server = parseTypeScriptSource(
  new URL('../src/server.ts', import.meta.url),
  readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'),
);

test('accepted probe client results share one current-generation fence', () => {
  const fence = functionCode(server, 'acceptCurrentProbeClientResult');

  assert.match(fence, /bootProbeRuntime\.acceptClientReply\(reply\.requestId, reply\.generation\)/);
  assert.match(fence, /!session\.active \|\| pending\.sessionGeneration !== session\.generation/);
  assert.match(fence, /probeGeneration\(pending\.target\) !== pending\.generation/);
  assert.match(fence, /abandonProbeRun\(\)/);
  assert.match(fence, /broadcastJson\(timingCalibrationStatusPayload\(\)\)/);

  // The reply's own capture generation is fenced one layer down, in
  // `ProbeLifecycle.acceptClientReply()`, which drops a mismatch *without*
  // consuming the request. That is deliberate: the phone reports its live
  // AudioWorklet generation rather than echoing the request, so a racy
  // mismatch has to leave the current request authoritative for the real
  // acknowledgement. `probe-server-lifecycle.test.ts` owns that behaviour.
  // Re-checking it here could only ever be unreachable code that looks like a
  // second policy.
  assert.doesNotMatch(
    fence,
    /Number\(reply\.generation\) >>> 0/,
    'reply-generation fencing belongs to ProbeLifecycle, not a second copy here',
  );
  assert.doesNotMatch(fence, /failProbeAttempt/);
});

test('probe reply and failure handlers delegate fencing instead of duplicating it', () => {
  const reply = functionCode(server, 'handleProbeReply');
  const failure = functionCode(server, 'handleProbeFailure');

  assert.match(reply, /acceptCurrentProbeClientResult\(reply, \{/);
  assert.match(reply, /logCaptureGenerationMismatch: true/);
  assert.match(failure, /acceptCurrentProbeClientResult\(reply\)/);

  for (const block of [reply, failure]) {
    assert.doesNotMatch(block, /bootProbeRuntime\.acceptClientReply/);
    assert.doesNotMatch(block, /pending\.sessionGeneration !== session\.generation/);
    assert.doesNotMatch(block, /probeGeneration\(pending\.target\) !== pending\.generation/);
    assert.doesNotMatch(block, /Number\(reply\.generation\) >>> 0/);
  }
});
