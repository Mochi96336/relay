import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const liveStatus = readFileSync(new URL('../public/live-status.js', import.meta.url), 'utf8');
const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const micRuntime = readFileSync(new URL('../src/mic-runtime.ts', import.meta.url), 'utf8');

test('product UI keeps Mic startup, PCM stall and transport reconnect distinct', () => {
  assert.match(liveStatus, /mic\.state === 'starting'/);
  assert.match(liveStatus, /mic\.state === 'interrupted'/);
  assert.match(liveStatus, /mic\.state === 'reconnecting'/);
  assert.match(liveStatus, /mic-audio-stalled/);
});

test('Mic flow freshness belongs to the current owner and capture generation', () => {
  assert.match(micRuntime, /this\.lastFrameOwnerId === this\.currentMediaOwnerId/);
  assert.match(micRuntime, /this\.lastFrameGeneration === this\.currentMediaGeneration/);
  assert.match(
    micRuntime,
    /bindPublisher\([\s\S]*if \(!preservedAudioTransport\)[\s\S]*this\.resetFlowEvidence\(nowMs\)/,
    'a fresh media generation must reset flow evidence inside the transport-state owner',
  );
});

test('Mic presence follows media availability and direct WebTransport can retain the lease', () => {
  assert.match(server, /micRuntime\.mediaOwnerId === ownerId[\s\S]*micMediaConnected\(\)/);
  assert.match(
    server,
    /directMediaStillFlowing[\s\S]*webTransportMicConnected\(\)[\s\S]*micStreaming\(performance\.now\(\)\)/,
  );
  assert.match(server, /scheduleMicTransportGrace\(expectedOwnerId\);/);
});
