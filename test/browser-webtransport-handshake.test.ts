import assert from 'node:assert/strict';
import { test } from 'node:test';

const moduleUrl = new URL('../public/audio-transport.js', import.meta.url);
const offer = { preferred: 'webtransport', url: 'https://media.example.test/media' };

async function fixture() {
  const { PreferredAudioTransport } = await import(moduleUrl.href);
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let timerId = 0;
  const candidates: Candidate[] = [];
  class Candidate {
    resolve!: () => void;
    reject!: (error: Error) => void;
    ready = new Promise<void>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    rejectClosed!: (error: Error) => void;
    closed = new Promise<void>((_, reject) => { this.rejectClosed = reject; });
    closeCalls = 0;
    writer = { write: async () => {}, releaseLock() {} };
    datagrams = { maxDatagramSize: 1200, writable: { getWriter: () => this.writer } };
    constructor() { candidates.push(this); }
    close() { this.closeCalls++; }
  }
  const transport = new PreferredAudioTransport({
    WebTransportClass: Candidate,
    webTransportHandshakeTimeoutMs: 5000,
    setTimer: (callback: () => void, delay: number) => {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimer: (id: number) => timers.delete(id),
  });
  const sent: unknown[] = [];
  transport.bind({ readyState: 1, bufferedAmount: 0, send: (value: unknown) => sent.push(value) });
  const tick = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
  const fireNext = async () => {
    const [id, timer] = timers.entries().next().value!;
    timers.delete(id);
    timer.callback();
    await tick();
  };
  return { transport, candidates, timers, sent, tick, fireNext };
}

test('a pending handshake times out, closes, and retries while WebSocket carries audio', async () => {
  const f = await fixture();
  try {
    const attempt = f.transport.prefer(offer);
    assert.equal(f.timers.values().next().value!.delay, 5000);
    assert.equal(f.transport.send('voice').path, 'websocket');
    assert.deepEqual(f.sent, ['voice']);
    await f.fireNext();
    assert.equal(await attempt, false);
    assert.equal(f.candidates[0].closeCalls, 1);
    f.candidates[0].rejectClosed(new Error('handshake cancelled'));
    assert.equal(f.transport.lastWebTransportFailure, 'connect:TimeoutError');
    assert.equal(f.timers.size, 1, 'the existing retry schedule owns the next attempt');
    await f.fireNext();
    assert.equal(f.candidates.length, 2);
    f.candidates[1].resolve();
    await f.tick();
    assert.equal(f.transport.datagramWriter, f.candidates[1].writer);
    assert.equal(f.timers.size, 0);
    // A timed-out candidate must never replace the recovered path.
    f.candidates[0].resolve();
    await f.tick();
    assert.equal(f.transport.datagramWriter, f.candidates[1].writer);
  } finally { f.transport.close(); }
});

test('replacing a pending offer cancels its promise and closes only the old candidate', async () => {
  const f = await fixture();
  try {
    const oldAttempt = f.transport.prefer(offer);
    const nextAttempt = f.transport.prefer({ ...offer, url: `${offer.url}?new` });
    assert.equal(await oldAttempt, false);
    assert.equal(f.candidates[0].closeCalls, 1);
    assert.equal(f.candidates[1].closeCalls, 0);
    assert.equal(f.timers.size, 1);
    f.candidates[1].resolve();
    assert.equal(await nextAttempt, true);
    f.candidates[0].reject(new Error('obsolete handshake'));
    await f.tick();
    assert.equal(f.transport.lastWebTransportFailure, null);
    assert.equal(f.transport.datagramWriter, f.candidates[1].writer);
    assert.equal(f.timers.size, 0);
  } finally { f.transport.close(); }
});

test('closing Mic cancels a pending handshake immediately and prevents late activation', async () => {
  const f = await fixture();
  const attempt = f.transport.prefer(offer);
  f.transport.close();
  assert.equal(f.candidates[0].closeCalls, 1);
  assert.equal(await attempt, false);
  assert.equal(f.timers.size, 0);
  f.candidates[0].resolve();
  await f.tick();
  assert.equal(f.transport.datagramWriter, null);
  assert.equal(f.timers.size, 0);
});

test('repeated handshake timeouts keep retrying and close cancels the retry timer', async () => {
  const f = await fixture();
  void f.transport.prefer(offer);
  await f.fireNext(); // handshake deadline
  await f.fireNext(); // retry
  await f.fireNext(); // retry handshake deadline
  assert.deepEqual(f.candidates.map(c => c.closeCalls), [1, 1]);
  assert.equal(f.timers.size, 1);
  f.transport.close();
  assert.equal(f.timers.size, 0);
});
