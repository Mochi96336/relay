import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');

function functionBlock(name: string, nextName: string) {
  const start = server.indexOf(`function ${name}(`);
  const end = server.indexOf(`\nfunction ${nextName}(`, start);
  assert.ok(start >= 0 && end > start, `${name} block must remain identifiable`);
  return server.slice(start, end);
}

test('accepted probe client results share one current-generation fence', () => {
  const fence = functionBlock('acceptCurrentProbeClientResult', 'handleProbeReply');

  assert.match(fence, /bootProbeRuntime\.acceptClientReply\(reply\.requestId, reply\.generation\)/);
  assert.match(fence, /!session\.active \|\| pending\.sessionGeneration !== session\.generation/);
  assert.match(fence, /probeGeneration\(pending\.target\) !== pending\.generation/);
  assert.match(fence, /pending\.target === 'mic'/);
  assert.match(fence, /\(Number\(reply\.generation\) >>> 0\) !== pending\.generation/);
  assert.match(fence, /abandonProbeRun\(\)/);
  assert.match(fence, /broadcastJson\(timingCalibrationStatusPayload\(\)\)/);
  assert.match(fence, /failProbeAttempt\('mic', options\.clientGenerationMismatchReason, nowMs\)/);
});

test('probe reply and failure handlers delegate fencing instead of duplicating it', () => {
  const reply = functionBlock('handleProbeReply', 'handleProbeFailure');
  const failure = functionBlock('handleProbeFailure', 'maybeFinishProbeAnalysis');

  assert.match(reply, /acceptCurrentProbeClientResult\(reply, nowMs, \{/);
  assert.match(reply, /client reported a different capture generation/);
  assert.match(reply, /logCaptureGenerationMismatch: true/);

  assert.match(failure, /acceptCurrentProbeClientResult\(reply, nowMs, \{/);
  assert.match(failure, /client failed from a different capture generation/);

  for (const block of [reply, failure]) {
    assert.doesNotMatch(block, /bootProbeRuntime\.acceptClientReply/);
    assert.doesNotMatch(block, /pending\.sessionGeneration !== session\.generation/);
    assert.doesNotMatch(block, /probeGeneration\(pending\.target\) !== pending\.generation/);
    assert.doesNotMatch(block, /Number\(reply\.generation\) >>> 0/);
  }
});
