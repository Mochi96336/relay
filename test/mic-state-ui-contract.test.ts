import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  classMethodCode,
  functionCode,
  parseTypeScriptSource,
  sourceCode,
} from './support/source-contract.js';

const liveStatus = parseTypeScriptSource(
  new URL('../public/live-status.js', import.meta.url),
  readFileSync(new URL('../public/live-status.js', import.meta.url), 'utf8'),
);
const server = parseTypeScriptSource(
  new URL('../src/server.ts', import.meta.url),
  readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'),
);
const micRuntime = parseTypeScriptSource(
  new URL('../src/mic-runtime.ts', import.meta.url),
  readFileSync(new URL('../src/mic-runtime.ts', import.meta.url), 'utf8'),
);

test('product UI keeps Mic startup, PCM stall and transport reconnect distinct', () => {
  const statusCode = sourceCode(liveStatus);
  assert.match(statusCode, /mic\.state === 'starting'/);
  assert.match(statusCode, /mic\.state === 'interrupted'/);
  assert.match(statusCode, /mic\.state === 'reconnecting'/);
  assert.match(statusCode, /mic-audio-stalled/);
});

test('Mic flow freshness belongs to the current owner and capture generation', () => {
  const flowObserved = classMethodCode(micRuntime, 'MicRuntime', 'flowObserved');
  assert.match(flowObserved, /this\.lastFrameOwnerId === this\.currentMediaOwnerId/);
  assert.match(flowObserved, /this\.lastFrameGeneration === this\.currentMediaGeneration/);

  const bindPublisher = classMethodCode(micRuntime, 'MicRuntime', 'bindPublisher');
  const replacementBranch = bindPublisher.indexOf('if (!preservedAudioTransport) {');
  const resetFlow = bindPublisher.indexOf('this.resetFlowEvidence(nowMs);', replacementBranch);
  const resultReturn = bindPublisher.indexOf('return {', resetFlow);
  assert.ok(replacementBranch >= 0, 'fresh media replacement branch must stay explicit');
  assert.ok(resetFlow > replacementBranch, 'a fresh media generation must reset flow evidence inside MicRuntime');
  assert.ok(resultReturn > resetFlow, 'flow evidence reset must happen before bindPublisher reports the replacement result');
});

test('Mic presence follows media availability and direct WebTransport can retain the lease', () => {
  const sessionStatus = functionCode(server, 'sessionStatusPayload');
  const ownerMatch = sessionStatus.indexOf('micRuntime.mediaOwnerId === ownerId');
  const mediaConnected = sessionStatus.indexOf('micMediaConnected()', ownerMatch);
  assert.ok(ownerMatch >= 0, 'session presence must belong to the current Mic media owner');
  assert.ok(mediaConnected > ownerMatch, 'session presence must require current Mic media connectivity');

  const graceExpiry = functionCode(server, 'expireMicTransportGrace');
  const directMedia = graceExpiry.indexOf('const directMediaStillFlowing =');
  const webTransport = graceExpiry.indexOf('webTransportMicConnected()', directMedia);
  const freshPcm = graceExpiry.indexOf('micStreaming(performance.now())', webTransport);
  const retainLease = graceExpiry.indexOf('micTransportGrace.schedule(expectedOwnerId);', freshPcm);
  assert.ok(directMedia >= 0, 'Mic grace expiry must classify independent direct media');
  assert.ok(webTransport > directMedia, 'direct media retention must require the WebTransport path');
  assert.ok(freshPcm > webTransport, 'direct media retention must require fresh PCM evidence');
  assert.ok(retainLease > freshPcm, 'fresh WebTransport PCM must retain the Mic lease through grace');
});
