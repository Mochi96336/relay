import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

import { authorityState } from '../public/authority-freshness.js';
import { formatTimingValueMs } from '../public/timing-value.js';

const adapterSource = readFileSync(new URL('../public/timing-authority.js', import.meta.url), 'utf8');
const calibrationUiSource = readFileSync(new URL('../public/calibration-ui.js', import.meta.url), 'utf8')
  .replace(/^import .*;\s*$/gm, '');

class FakeClock {
  now = 0;
  nextId = 1;
  timers = new Map<number, { at: number; intervalMs: number | null; callback: () => void }>();

  setTimeout = (callback: () => void, delayMs = 0) => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + delayMs, intervalMs: null, callback });
    return id;
  };

  clearTimeout = (id: number) => {
    this.timers.delete(id);
  };

  setInterval = (callback: () => void, intervalMs = 0) => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + intervalMs, intervalMs, callback });
    return id;
  };

  clearInterval = (id: number) => {
    this.timers.delete(id);
  };

  advance(ms: number) {
    const target = this.now + ms;
    while (true) {
      let nextId: number | null = null;
      let nextAt = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.timers) {
        if (timer.at < nextAt) {
          nextId = id;
          nextAt = timer.at;
        }
      }
      if (nextId === null || nextAt > target) break;

      this.now = nextAt;
      const timer = this.timers.get(nextId);
      if (!timer) continue;
      if (timer.intervalMs === null) this.timers.delete(nextId);
      else timer.at += timer.intervalMs;
      timer.callback();
    }
    this.now = target;
  }
}

class FakeElement {
  textContent = '';
}

function eventWindow() {
  const listeners = new Map<string, Array<(event: any) => void>>();
  return {
    addEventListener(type: string, listener: (event: any) => void) {
      const current = listeners.get(type) ?? [];
      current.push(listener);
      listeners.set(type, current);
    },
    dispatchEvent(event: any) {
      for (const listener of listeners.get(event.type) ?? []) listener(event);
      return true;
    },
  };
}

test('OPEN socket loses timing authority after six missed polls and a fresh snapshot restores it', () => {
  const clock = new FakeClock();
  const sockets: FakeWebSocket[] = [];

  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;

    readyState = FakeWebSocket.CONNECTING;
    sent: string[] = [];
    listeners = new Map<string, Array<(event: any) => void>>();

    constructor(public url: string) {
      sockets.push(this);
    }

    addEventListener(type: string, listener: (event: any) => void) {
      const current = this.listeners.get(type) ?? [];
      current.push(listener);
      this.listeners.set(type, current);
    }

    send(payload: string) {
      this.sent.push(payload);
    }

    emit(type: string, event: any = {}) {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }

    open() {
      this.readyState = FakeWebSocket.OPEN;
      this.emit('open');
    }

    message(message: unknown) {
      this.emit('message', { data: JSON.stringify(message) });
    }

    close() {
      this.readyState = 3;
      this.emit('close');
    }
  }

  class CustomEvent {
    constructor(public type: string, public init: { detail: unknown }) {}
    get detail() { return this.init.detail; }
  }

  const timingLabel = new FakeElement();
  const timingValue = new FakeElement();
  const document = {
    readyState: 'complete',
    querySelector(selector: string) {
      if (selector === '#timing-active-label') return timingLabel;
      if (selector === '#timing-active-value') return timingValue;
      return null;
    },
  };
  const window = {
    ...eventWindow(),
    relayI18n: { t: (key: string) => key },
  } as any;
  const context = {
    window,
    document,
    location: { protocol: 'https:', host: 'relay.test', search: '' },
    URLSearchParams,
    WebSocket: FakeWebSocket,
    CustomEvent,
    Date: { now: () => clock.now },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    authorityState,
    formatTimingValueMs,
  };

  runInNewContext(adapterSource, context);
  runInNewContext(calibrationUiSource, context);

  assert.equal(sockets.length, 1);
  const socket = sockets[0];
  socket.open();
  assert.deepEqual(JSON.parse(socket.sent[0]), { type: 'source-status-request' });

  socket.message({ type: 'source-status', active: true, appliedMicAdvanceMs: 42 });
  assert.equal(window.relayTimingAuthority.authorityFresh, true);
  assert.equal(window.relayTimingAuthority.valueMs, 42);
  assert.equal(timingValue.textContent, '+42 ms');

  clock.advance(1_000);
  socket.message({ type: 'source-status', active: true, appliedMicAdvanceMs: 43 });
  assert.equal(window.relayTimingAuthority.authorityFresh, true);
  assert.equal(timingValue.textContent, '+43 ms');

  clock.advance(1_499);
  assert.equal(socket.readyState, FakeWebSocket.OPEN, 'transport must remain OPEN for the stale-authority proof');
  assert.equal(window.relayTimingAuthority.authorityFresh, true,
    'a fresh snapshot must reset the freshness deadline');
  assert.equal(timingValue.textContent, '+43 ms');

  clock.advance(1);
  assert.equal(socket.readyState, FakeWebSocket.OPEN);
  assert.equal(window.relayTimingAuthority.authorityFresh, false);
  assert.equal(window.relayTimingAuthority.valueMs, null);
  assert.equal(timingValue.textContent, '—');
  assert.ok(socket.sent.length >= 10, 'polling continues while responses are absent');

  socket.message({ type: 'source-status', active: true, appliedMicAdvanceMs: -37 });
  assert.equal(window.relayTimingAuthority.authorityFresh, true);
  assert.equal(window.relayTimingAuthority.valueMs, -37);
  assert.equal(timingValue.textContent, '-37 ms');
});

test('freshness TTL is derived from the source-status polling cadence', () => {
  assert.match(adapterSource, /const REFRESH_MS = 250/);
  assert.match(adapterSource, /const FRESHNESS_TTL_MS = REFRESH_MS \* 6/);
  assert.match(adapterSource, /lastObservedAt = Date\.now\(\)/);
  assert.match(adapterSource, /setTimeout\([\s\S]*FRESHNESS_TTL_MS\)/);
  assert.match(adapterSource, /expireTimingAuthority\(\)/);
});
