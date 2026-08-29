import assert from 'node:assert/strict';
import test from 'node:test';

import { BackingRuntime } from '../src/backing-runtime.js';

type FakeSocket = { id: string; open: boolean };

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

test('BackingRuntime owns backing identity, format, route kind and frame freshness', () => {
  const first: FakeSocket = { id: 'first', open: true };
  const second: FakeSocket = { id: 'second', open: true };
  const runtime = new BackingRuntime<FakeSocket>({
    graceMs: 50,
    isConnected: (socket) => socket.open,
    onGraceExpired: () => {},
  });

  assert.equal(runtime.connected(), false);
  assert.equal(runtime.armed(), false);
  assert.equal(runtime.sampleRate, null);
  assert.equal(runtime.isRobot, false);

  assert.deepEqual(runtime.bind({ socket: first, sampleRate: 48_000, robot: true }), {
    previous: null,
    sameSocket: false,
  });
  assert.equal(runtime.socket, first);
  assert.equal(runtime.sampleRate, 48_000);
  assert.equal(runtime.isRobot, true);
  assert.equal(runtime.connected(), true);
  assert.equal(runtime.noteFrame(first, 100), true);
  assert.equal(runtime.lastFrameAt, 100);
  assert.equal(runtime.streaming(1_099, 1_000), true);
  assert.equal(runtime.streaming(1_100, 1_000), false);

  runtime.bind({ socket: first, sampleRate: 44_100, robot: false });
  assert.equal(runtime.lastFrameAt, 100, 'same physical socket re-registration preserves freshness');
  assert.equal(runtime.sampleRate, 44_100);
  assert.equal(runtime.isRobot, false);

  const replacement = runtime.bind({ socket: second, sampleRate: 48_000, robot: true });
  assert.equal(replacement.previous, first);
  assert.equal(replacement.sameSocket, false);
  assert.equal(runtime.lastFrameAt, Number.NEGATIVE_INFINITY, 'replacement starts without inherited PCM freshness');
  assert.equal(runtime.noteFrame(first, 200), false, 'replaced socket cannot refresh the active route');
  assert.equal(runtime.noteFrame(second, 210), true);
});

test('BackingRuntime keeps route kind through reconnect grace and cancels expiry on rebind', async () => {
  const socket: FakeSocket = { id: 'backing', open: true };
  let expirations = 0;
  const runtime = new BackingRuntime<FakeSocket>({
    graceMs: 15,
    isConnected: (candidate) => candidate.open,
    onGraceExpired: () => { expirations += 1; },
  });

  runtime.bind({ socket, sampleRate: 48_000, robot: true });
  runtime.noteFrame(socket, 100);
  assert.equal(runtime.detach(socket), true);
  assert.equal(runtime.socket, null);
  assert.equal(runtime.sampleRate, null);
  assert.equal(runtime.lastFrameAt, Number.NEGATIVE_INFINITY);
  assert.equal(runtime.isRobot, true, 'route identity remains authoritative during reconnect grace');
  assert.equal(runtime.gracePending, true);
  assert.equal(runtime.armed(), true);

  runtime.bind({ socket, sampleRate: 48_000, robot: true });
  assert.equal(runtime.gracePending, false);
  await delay(25);
  assert.equal(expirations, 0, 'successful reconnect cancels the old expiry');

  assert.equal(runtime.detach(socket), true);
  await delay(25);
  assert.equal(expirations, 1);
  assert.equal(runtime.gracePending, false);
  assert.equal(runtime.armed(), false);
  assert.equal(runtime.isRobot, true);
  runtime.retireRobotRoute();
  assert.equal(runtime.isRobot, false);
});
