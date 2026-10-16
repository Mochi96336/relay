import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openAudioSocket } from '../public/open-audio-socket.js';

function fixture(outcomes: ('open' | 'error' | 'timeout')[]) {
  const sockets: FakeSocket[] = [];
  let wanted = true;
  let failures = 0;
  class FakeSocket extends EventTarget {
    closed = false;
    binaryType = 'blob';
    constructor(readonly url: string) {
      super();
      sockets.push(this);
      const outcome = outcomes.shift();
      if (outcome !== 'timeout') queueMicrotask(() => this.dispatchEvent(new Event(outcome!)));
    }
    close() { this.closed = true; this.dispatchEvent(new Event('close')); }
  }
  const connect = () => openAudioSocket({
    directUrl: 'wss://direct.example/ws', tunnelUrl: 'wss://relay.example/ws',
    onPending: () => {}, onDirectFailure: () => { failures++; },
    stillWanted: () => wanted, timeoutMs: 10,
    WebSocketClass: FakeSocket as unknown as typeof WebSocket,
  });
  return { sockets, connect, cancel: () => { wanted = false; }, failures: () => failures };
}

test('Listen takes the direct route without opening a second socket', async () => {
  const f = fixture(['open']);
  const socket = await f.connect();
  assert.equal(socket.url, 'wss://direct.example/ws');
  assert.equal(socket.binaryType, 'arraybuffer');
  assert.equal(f.sockets.length, 1);
  assert.equal(f.failures(), 0);
});

for (const failure of ['error', 'timeout'] as const) {
  test(`Listen falls back after direct ${failure} and closes the failed socket`, async () => {
    const f = fixture([failure, 'open']);
    const socket = await f.connect();
    assert.equal(socket.url, 'wss://relay.example/ws');
    assert.equal(f.sockets[0].closed, true);
    assert.equal(f.failures(), 1);
  });
}

test('revoked playback intent cannot open a fallback socket', async () => {
  const f = fixture(['timeout', 'open']);
  const pending = f.connect();
  f.cancel();
  f.sockets[0].close();
  await assert.rejects(pending);
  assert.equal(f.sockets.length, 1);
  assert.equal(f.failures(), 0);
});
