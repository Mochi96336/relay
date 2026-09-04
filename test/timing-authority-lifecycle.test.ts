import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../public/timing-authority.js', import.meta.url), 'utf8');

type SocketListener = (event?: { data?: string }) => void;

test('timing authority keeps polling across idle and observes the later applied value', () => {
  const sockets: FakeSocket[] = [];
  const intervals = new Map<number, () => void>();
  const clearedIntervals = new Set<number>();
  const timeouts = new Map<number, () => void>();
  let nextTimerId = 1;

  class FakeSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 3;

    readyState = FakeSocket.CONNECTING;
    readonly sent: string[] = [];
    readonly listeners = new Map<string, SocketListener[]>();

    constructor(readonly url: string) {
      sockets.push(this);
    }

    addEventListener(type: string, listener: SocketListener) {
      const current = this.listeners.get(type) ?? [];
      current.push(listener);
      this.listeners.set(type, current);
    }

    emit(type: string, event: { data?: string } = {}) {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }

    send(payload: string) {
      this.sent.push(payload);
    }

    close() {
      this.readyState = FakeSocket.CLOSED;
      this.emit('close');
    }
  }

  const window = {
    relayTimingAuthority: null as null | { authorityFresh: boolean; valueMs: number | null },
    dispatchEvent() {},
  };

  class CustomEvent {
    constructor(
      readonly type: string,
      readonly init: { detail?: unknown } = {},
    ) {}
  }

  runInNewContext(source, {
    window,
    WebSocket: FakeSocket,
    location: { protocol: 'https:', host: 'relay.test', search: '' },
    URLSearchParams,
    CustomEvent,
    Date,
    JSON,
    setInterval(callback: () => void) {
      const id = nextTimerId++;
      intervals.set(id, callback);
      return id;
    },
    clearInterval(id: number) {
      clearedIntervals.add(id);
      intervals.delete(id);
    },
    setTimeout(callback: () => void) {
      const id = nextTimerId++;
      timeouts.set(id, callback);
      return id;
    },
    clearTimeout(id: number) {
      timeouts.delete(id);
    },
  });

  assert.equal(sockets.length, 1);
  const socket = sockets[0]!;
  socket.readyState = FakeSocket.OPEN;
  socket.emit('open');

  assert.equal(socket.sent.length, 1, 'open should request the first source snapshot immediately');
  const refreshId = [...intervals.keys()][0];
  assert.ok(refreshId, 'open socket should keep a refresh loop alive');

  socket.emit('message', {
    data: JSON.stringify({
      type: 'source-status',
      active: false,
      appliedMicAdvanceMs: 0,
    }),
  });

  assert.equal(window.relayTimingAuthority?.authorityFresh, true);
  assert.equal(window.relayTimingAuthority?.valueMs, null);
  assert.equal(clearedIntervals.has(refreshId!), false,
    'an idle source snapshot must not stop observation of a later active mix');

  intervals.get(refreshId!)?.();
  assert.equal(socket.sent.length, 2,
    'the adapter should keep asking for source status while the socket remains open');

  socket.emit('message', {
    data: JSON.stringify({
      type: 'source-status',
      active: true,
      robotRoute: true,
      activeCalibrationKind: 'boot-probe',
      timingMode: 'network-estimate',
      robotDeltaFresh: false,
      appliedMicAdvanceMs: 0,
    }),
  });

  assert.equal(window.relayTimingAuthority?.authorityFresh, true);
  assert.equal(window.relayTimingAuthority?.valueMs, null,
    'path-ready Robot calibration awaiting player delta must not expose fallback zero as user timing');

  socket.emit('message', {
    data: JSON.stringify({
      type: 'source-status',
      active: true,
      robotRoute: true,
      activeCalibrationKind: 'boot-probe',
      timingMode: 'acoustic-calibration',
      robotDeltaFresh: false,
      appliedMicAdvanceMs: 0,
    }),
  });

  assert.equal(window.relayTimingAuthority?.authorityFresh, true);
  assert.equal(window.relayTimingAuthority?.valueMs, 0,
    'a real applied path-only measurement of exactly zero must remain visible as 0 ms');

  socket.emit('message', {
    data: JSON.stringify({
      type: 'source-status',
      active: true,
      robotRoute: true,
      activeCalibrationKind: 'boot-probe',
      timingMode: 'acoustic-calibration',
      robotDeltaFresh: true,
      appliedMicAdvanceMs: 143,
    }),
  });

  assert.equal(window.relayTimingAuthority?.authorityFresh, true);
  assert.equal(window.relayTimingAuthority?.valueMs, 143,
    'once player delta promotes the complete Robot alignment, the final applied value must become visible');

  socket.emit('message', {
    data: JSON.stringify({
      type: 'source-status',
      active: true,
      appliedMicAdvanceMs: 37,
    }),
  });

  assert.equal(window.relayTimingAuthority?.authorityFresh, true);
  assert.equal(window.relayTimingAuthority?.valueMs, 37);
});
