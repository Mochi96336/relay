import assert from 'node:assert/strict';
import test from 'node:test';

const moduleUrl = new URL('../public/publisher-control-liveness.js', import.meta.url).href;
const { PublisherControlLiveness } = await import(moduleUrl) as {
  PublisherControlLiveness: new (options?: {
    timeoutMs?: number;
    setTimer?: typeof setTimeout;
    clearTimer?: typeof clearTimeout;
  }) => {
    observe(socket: unknown): boolean;
    snapshot(): { active: boolean; lastAckGeneration: number | null; leaseEpoch: number };
  };
};

type Listener = (event: { data?: string }) => void;

class FakeSocket {
  listeners = new Map<string, Listener[]>();
  closed: Array<{ code?: number; reason?: string }> = [];

  addEventListener(type: string, listener: Listener) {
    const current = this.listeners.get(type) ?? [];
    current.push(listener);
    this.listeners.set(type, current);
  }

  emit(type: string, payload: unknown = null) {
    const event = type === 'message' ? { data: JSON.stringify(payload) } : {};
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  close(code?: number, reason?: string) {
    this.closed.push({ code, reason });
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('publisher registration seeds a bounded browser application-liveness lease', async () => {
  const liveness = new PublisherControlLiveness({ timeoutMs: 25 });
  const socket = new FakeSocket();
  assert.equal(liveness.observe(socket), true);

  socket.emit('message', { type: 'registered', role: 'publisher' });
  await sleep(70);

  assert.deepEqual(socket.closed, [{ code: 4000, reason: 'publisher command liveness stale' }]);
});

test('accepted health ack renews the browser publisher lease', async () => {
  const liveness = new PublisherControlLiveness({ timeoutMs: 45 });
  const socket = new FakeSocket();
  liveness.observe(socket);
  socket.emit('message', { type: 'registered', role: 'publisher' });

  await sleep(25);
  socket.emit('message', {
    type: 'audio-uplink-health-ack',
    version: 1,
    captureGeneration: 7,
  });
  await sleep(30);
  assert.equal(socket.closed.length, 0, 'ack must move the deadline instead of replaying the old timer');

  await sleep(40);
  assert.equal(socket.closed.length, 1);
  assert.equal(liveness.snapshot().lastAckGeneration, 7);
});

test('a late ack from a replaced publisher socket cannot renew the replacement lease', async () => {
  const liveness = new PublisherControlLiveness({ timeoutMs: 45 });
  const first = new FakeSocket();
  const replacement = new FakeSocket();
  liveness.observe(first);
  liveness.observe(replacement);

  first.emit('message', { type: 'registered', role: 'publisher' });
  await sleep(20);
  replacement.emit('message', { type: 'registered', role: 'publisher' });
  await sleep(20);
  first.emit('message', {
    type: 'audio-uplink-health-ack',
    version: 1,
    captureGeneration: 12,
  });

  await sleep(40);
  assert.equal(first.closed.length, 0, 'superseded browser socket must no longer own the deadline');
  assert.deepEqual(replacement.closed, [{ code: 4000, reason: 'publisher command liveness stale' }]);
});

test('non-publisher registrations and malformed acks never arm or renew publisher liveness', async () => {
  const liveness = new PublisherControlLiveness({ timeoutMs: 20 });
  const socket = new FakeSocket();
  liveness.observe(socket);

  socket.emit('message', { type: 'registered', role: 'listener' });
  socket.emit('message', {
    type: 'audio-uplink-health-ack',
    version: 1,
    captureGeneration: -1,
  });
  await sleep(60);

  assert.equal(socket.closed.length, 0);
  assert.equal(liveness.snapshot().active, false);
});

test('socket close clears the browser liveness deadline', async () => {
  const liveness = new PublisherControlLiveness({ timeoutMs: 20 });
  const socket = new FakeSocket();
  liveness.observe(socket);
  socket.emit('message', { type: 'registered', role: 'publisher' });
  socket.emit('close');

  await sleep(60);
  assert.equal(socket.closed.length, 0);
  assert.equal(liveness.snapshot().active, false);
});
