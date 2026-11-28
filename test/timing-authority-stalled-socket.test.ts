import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const wsUrlSource = readFileSync(new URL('../public/ws-url.js', import.meta.url), 'utf8')
  .replace(/^export /m, '');
const source = wsUrlSource
  + readFileSync(new URL('../public/timing-authority.js', import.meta.url), 'utf8')
    .replace(/^import .*;\s*$/gm, '');

type Listener = (event?: { data?: string }) => void;

/** The adapter on a virtual clock with scripted sockets. */
function adapter() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; every: number | null; run: () => void }>();
  const sockets: FakeSocket[] = [];

  class FakeSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 3;
    readyState = FakeSocket.CONNECTING;
    readonly sent: string[] = [];
    readonly listeners = new Map<string, Listener[]>();
    constructor(readonly url: string) { sockets.push(this); }
    addEventListener(type: string, listener: Listener) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    emit(type: string, event: { data?: string } = {}) {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
    send(payload: string) { this.sent.push(payload); }
    close() {
      if (this.readyState === FakeSocket.CLOSED) return;
      this.readyState = FakeSocket.CLOSED;
      this.emit('close');
    }
    open() { this.readyState = FakeSocket.OPEN; this.emit('open'); }
    answer(valueMs: number) {
      this.emit('message', { data: JSON.stringify({ type: 'source-status', active: true, appliedMicAdvanceMs: valueMs }) });
    }
    polls() { return this.sent.filter((payload) => JSON.parse(payload).type === 'source-status-request').length; }
  }

  const window = {
    relayTimingAuthority: null as null | { authorityFresh: boolean; valueMs: number | null },
    dispatchEvent() {},
  };
  class CustomEvent { constructor(readonly type: string, readonly init: { detail?: unknown } = {}) {} }
  const schedule = (run: () => void, ms: number, every: number | null) => {
    const id = nextId++;
    timers.set(id, { at: now + ms, every, run });
    return id;
  };
  runInNewContext(source, {
    window,
    WebSocket: FakeSocket,
    location: { protocol: 'https:', host: 'relay.test', search: '' },
    URLSearchParams,
    CustomEvent,
    Date: { now: () => now },
    JSON,
    setInterval: (run: () => void, ms: number) => schedule(run, ms, ms),
    clearInterval: (id: number) => timers.delete(id),
    setTimeout: (run: () => void, ms: number) => schedule(run, ms, null),
    clearTimeout: (id: number) => timers.delete(id),
  });

  /** Advances the clock, running due timers; `onPoll` answers for a socket. */
  function advance(ms: number, onTick: () => void = () => {}) {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, timer] = due;
      now = timer.at;
      if (timer.every === null) timers.delete(id); else timer.at += timer.every;
      timer.run();
      onTick();
    }
    now = end;
  }
  const intervals = () => [...timers.values()].filter((timer) => timer.every !== null).length;
  return { window, sockets, advance, intervals, current: () => sockets.at(-1)! };
}

test('a handshake that never completes is replaced', () => {
  const a = adapter();
  a.advance(4_900);
  assert.equal(a.sockets.length, 1, 'a slow handshake is given time');
  a.advance(1_200);
  assert.equal(a.sockets.length, 2, 'then abandoned for a new socket');
  assert.equal(a.sockets[0]!.readyState, 3);
  a.current().open();
  a.current().answer(37);
  assert.equal(a.window.relayTimingAuthority?.valueMs, 37);
});

test('an open socket that never answers, or stops answering, is replaced once; its late answers are ignored', () => {
  for (const answeredFirst of [false, true]) {
    const a = adapter();
    const first = a.current();
    first.open();
    if (answeredFirst) first.answer(37);
    a.advance(1_600);
    assert.equal(a.window.relayTimingAuthority?.valueMs ?? null, null, 'the value expires with the freshness TTL');
    assert.equal(a.sockets.length, 1, 'expiry alone does not churn the socket');
    a.advance(2_500);
    assert.equal(a.sockets.length, 2, 'no answer for twice the TTL: replaced');
    const second = a.current();
    second.open();
    second.answer(41);
    first.answer(999);
    first.emit('close');
    assert.equal(a.window.relayTimingAuthority?.valueMs, 41, 'the old socket cannot overwrite the new one');
    assert.equal(a.intervals(), 1, 'one poller');
    const before = second.polls();
    a.advance(1_000, () => second.answer(41));
    assert.equal(second.polls() - before, 4);
    assert.equal(a.sockets.length, 2, 'the old close did not start another socket');
  }
});

test('a healthy socket and short delays keep the same socket and value', () => {
  const a = adapter();
  const socket = a.current();
  socket.open();
  socket.answer(37);
  let ticks = 0;
  // Every fourth poll goes unanswered: gaps of up to about 1 s.
  a.advance(20_000, () => { ticks += 1; if (ticks % 4 !== 0) socket.answer(37); });
  assert.equal(a.sockets.length, 1);
  assert.equal(a.window.relayTimingAuthority?.valueMs, 37);
  assert.equal(a.window.relayTimingAuthority?.authorityFresh, true);
});
