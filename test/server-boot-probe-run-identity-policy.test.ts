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
const readinessSource = readFileSync(
  new URL('../src/boot-probe-analysis-readiness-policy.ts', import.meta.url),
  'utf8',
);

test('accepted probe replies delegate the same run-identity fence without eager generation sampling', () => {
  assert.ok(importSources(server).includes('./boot-probe-run-identity-policy.js'));
  const accept = functionCode(server, 'acceptCurrentProbeClientResult');
  const claim = accept.indexOf('bootProbeRuntime.acceptClientReply(');
  const sessionFact = accept.indexOf('const sessionCurrent =');
  const generationFact = accept.indexOf('const captureGenerationMatches =');
  const decision = accept.indexOf('decideBootProbeRunIdentity({');
  const abandon = accept.indexOf("if (identity.kind === 'abandon')");
  const effect = accept.indexOf('abandonProbeRun()', abandon);
  const report = accept.indexOf('broadcastJson(timingCalibrationStatusPayload())', abandon);

  assert.ok(claim >= 0);
  assert.ok(sessionFact > claim, 'request ownership is resolved before server run identity');
  assert.ok(generationFact > sessionFact);
  assert.ok(decision > generationFact);
  assert.ok(abandon > decision);
  assert.ok(effect > abandon);
  assert.ok(report > effect);
  assert.match(
    accept,
    /const captureGenerationMatches = sessionCurrent\s*\? probeGeneration\(pending\.target\) === pending\.generation\s*:\s*false/,
    'capture generation must not be sampled once the accepted request belongs to a stale session',
  );
  assert.match(
    accept,
    /identity\.reason === 'capture-generation'\s*&& options\.logCaptureGenerationMismatch\s*&& PROBE_DEBUG/,
    'only capture-generation abandonment keeps the existing debug message',
  );
  assert.doesNotMatch(accept, /if \(!session\.active \|\| pending\.sessionGeneration !== session\.generation\)/);
  assert.doesNotMatch(accept, /if \(probeGeneration\(pending\.target\) !== pending\.generation\)/);
});

test('analysis readiness delegates identity precedence to the shared policy before deadline/window checks', () => {
  assert.match(
    readinessSource,
    /import \{ decideBootProbeRunIdentity \} from '\.\/boot-probe-run-identity-policy\.js';/,
  );
  const identity = readinessSource.indexOf('decideBootProbeRunIdentity({');
  const deadline = readinessSource.indexOf('if (input.nowMs > input.deadlineMs)');
  const window = readinessSource.indexOf('if (input.reachedSamples < input.neededSamples)');
  assert.ok(identity >= 0);
  assert.ok(deadline > identity);
  assert.ok(window > deadline);
  assert.doesNotMatch(readinessSource, /if \(!input\.sessionCurrent\)/);
  assert.doesNotMatch(readinessSource, /if \(!input\.captureGenerationMatches\)/);
});
