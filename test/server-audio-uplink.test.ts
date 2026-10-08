import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');

test('the socket message handler hands binary audio to audioUplinkReceived', () => {
  assert.match(server, /audioUplinkReceived\(socket, data as Buffer\)/);

  const start = server.indexOf('if (isBinary) {');
  const end = server.indexOf('let message: unknown;', start);
  assert.ok(start >= 0 && end > start, 'binary message branch must remain identifiable');
  const binary = server.slice(start, end);
  assert.doesNotMatch(binary, /micRuntime\.receivePublisher/);
  assert.doesNotMatch(binary, /session\.ingestBacking/);
  assert.doesNotMatch(binary, /decodePcmFrame/);
});
