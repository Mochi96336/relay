import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { waitForSocketOpen } from '../public/socket-open.js';

class FakeSocket extends EventTarget {
  closed = 0;
  close() { this.closed += 1; this.dispatchEvent(new Event('close')); }
}

test('a handshake that never answers is closed at its deadline', async () => {
  const socket = new FakeSocket();
  const started = performance.now();
  await assert.rejects(waitForSocketOpen(socket as unknown as WebSocket, 30), /timed out/);
  assert.ok(performance.now() - started >= 25);
  assert.equal(socket.closed, 1);
});

test('open resolves and a close or error before open rejects, without a later timeout close', async () => {
  const opened = new FakeSocket();
  const pending = waitForSocketOpen(opened as unknown as WebSocket, 30);
  opened.dispatchEvent(new Event('open'));
  await pending;
  const refused = new FakeSocket();
  const failing = waitForSocketOpen(refused as unknown as WebSocket, 30);
  refused.dispatchEvent(new Event('error'));
  await assert.rejects(failing);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(opened.closed, 0, 'an opened socket is never closed by the deadline');
  assert.equal(refused.closed, 0);
});

test('Presence and room status bound their handshake and release the stalled socket for reconnect', async () => {
  for (const file of ['presence.js', 'live-status.js']) {
    const source = await readFile(new URL(`../public/${file}`, import.meta.url), 'utf8');
    assert.match(source, /await waitForSocketOpen\(next\);/, file);
    assert.match(source, /catch \(error\) \{\s*\/\/[^\n]*\n\s*if \(socket === next\) socket = null;\s*throw error;/, file);
    assert.match(source, /connect\(\)\.catch\(scheduleReconnect\)/, file);
  }
});
