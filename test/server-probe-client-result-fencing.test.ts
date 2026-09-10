import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  functionCode,
  importSources,
  parseTypeScriptSource,
} from './support/source-contract.js';

const server = parseTypeScriptSource(
  new URL('../src/server.ts', import.meta.url),
  readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'),
);

test('accepted probe client results share one current-generation fence', () => {
  assert.ok(importSources(server).includes('./boot-probe-run-identity-policy.js'));
  const fence = functionCode(server, 'acceptCurrentProbeClientResult');

  const claim = fence.indexOf('bootProbeRuntime.acceptClientReply(');
  const sessionFact = fence.indexOf('const sessionCurrent =');
  const generationFact = fence.indexOf('const captureGenerationMatches =');
  const decision = fence.indexOf('decideBootProbeRunIdentity({');
  const abandonBranch = fence.indexOf("if (identity.kind === 'abandon')");
  const abandon = fence.indexOf('abandonProbeRun()', abandonBranch);
  const report = fence.indexOf(
    'broadcastJson(timingCalibrationStatusPayload())',
    abandonBranch,
  );

  assert.ok(claim >= 0, 'ProbeLifecycle must resolve request ownership first');
  assert.ok(sessionFact > claim, 'server run identity is checked only after a valid claim');
  assert.ok(generationFact > sessionFact);
  assert.ok(decision > generationFact);
  assert.ok(abandonBranch > decision);
  assert.ok(abandon > abandonBranch);
  assert.ok(report > abandon);

  assert.match(
    fence,
    /const sessionCurrent = session\.active\s*&& pending\.sessionGeneration === session\.generation/,
  );
  assert.match(
    fence,
    /const captureGenerationMatches = sessionCurrent\s*\? probeGeneration\(pending\.target\) === pending\.generation\s*:\s*false/,
    'capture generation must not be sampled after the accepted request belongs to a stale session',
  );
  assert.match(
    fence,
    /decideBootProbeRunIdentity\(\{\s*sessionCurrent,\s*captureGenerationMatches,\s*\}\)/,
  );

  // The reply's own capture generation is fenced one layer down, in
  // `ProbeLifecycle.acceptClientReply()`, which drops a mismatch *without*
  // consuming the request. That is deliberate: the phone reports its live
  // AudioWorklet generation rather than echoing the request, so a racy
  // mismatch has to leave the current request authoritative for the real
  // acknowledgement. `probe-server-lifecycle.test.ts` owns that behaviour.
  assert.doesNotMatch(
    fence,
    /Number\(reply\.generation\) >>> 0/,
    'reply-generation fencing belongs to ProbeLifecycle, not a second copy here',
  );
  assert.doesNotMatch(
    fence,
    /if \(!session\.active \|\| pending\.sessionGeneration !== session\.generation\)/,
    'server run identity must delegate rather than duplicate the old session fence',
  );
  assert.doesNotMatch(
    fence,
    /if \(probeGeneration\(pending\.target\) !== pending\.generation\)/,
    'server run identity must delegate rather than duplicate the old capture fence',
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
    assert.doesNotMatch(block, /decideBootProbeRunIdentity/);
    assert.doesNotMatch(block, /Number\(reply\.generation\) >>> 0/);
  }
});
