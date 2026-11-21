import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { authorityState } from '../public/authority-freshness.js';

async function recorderPage() {
  const source = (await readFile(new URL('../public/recorder.js', import.meta.url), 'utf8'))
    .replace(/^import[^\n]*\n/gm, '')
    .replace(/^await window\.relayIdentityReady;\n/m, '');
  const timers = new Map<number, { at: number; run: () => void }>();
  let now = 0;
  let timerId = 0;
  const sent: any[] = [];
  let socket: any = null;
  class FakeSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    readyState = 0;
    handlers = new Map<string, Array<(event: any) => void>>();
    constructor() { socket = this; }
    addEventListener(type: string, fn: (event: any) => void) {
      this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
    }
    removeEventListener(type: string, fn: (event: any) => void) {
      this.handlers.set(type, (this.handlers.get(type) ?? []).filter(h => h !== fn));
    }
    send(data: string) { sent.push(JSON.parse(data)); }
    close() {}
    reply(message: unknown) { for (const fn of this.handlers.get('message') ?? []) fn({ data: JSON.stringify(message) }); }
  }
  const buttons = new Map<string, any>();
  const button = (id: string) => {
    const listeners: Array<() => void> = [];
    const node = { id, addEventListener: (_: string, fn: () => void) => listeners.push(fn), click: () => listeners.forEach(fn => fn()) };
    buttons.set(id, node);
    return node;
  };
  const window: any = {
    relayParticipantId: 'singer',
    addEventListener() {},
    dispatchEvent() {},
  };
  vm.runInNewContext(source, {
    window,
    document: { querySelector: (s: string) => buttons.get(s.slice(1)) ?? button(s.slice(1)) },
    WebSocket: FakeSocket,
    CustomEvent: class { constructor(public type: string, public init: any) {} },
    authorityState,
    sendParticipantAuthentication() { return true; },
    wsUrl: () => 'ws://relay.test',
    Date: { now: () => now },
    setTimeout: (run: () => void, delay: number) => { timers.set(++timerId, { at: now + delay, run }); return timerId; },
    clearTimeout: (id: number) => timers.delete(id),
    setInterval() {},
    console,
    removeEventListener() {},
  });
  socket.readyState = 1;
  for (const fn of socket.handlers.get('open') ?? []) fn({});
  await new Promise((resolve) => setImmediate(resolve));
  const ready = (takeId: string) => ({ type: 'take-status', lifecycle: 'ready', take: { takeId }, history: [] });
  socket.reply({ type: 'product-status', actions: { canStartTake: true }, take: { lifecycle: 'ready' } });
  socket.reply(ready('older'));
  return {
    socket, sent, window, ready,
    record: () => buttons.get('start-recording').click(),
    pending: () => window.relayRecordingState?.startPending,
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.run(); }
    },
  };
}

test('a ready snapshot for a new Take settles Record even when the in-between notices were missed', async () => {
  const f = await recorderPage();
  f.record();
  assert.equal(f.sent.filter(m => m.type === 'start-take').length, 1);
  assert.equal(f.pending(), true);
  f.socket.reply(f.ready('older'));
  assert.equal(f.pending(), true, 'a replay of the Take before this press proves nothing');
  f.socket.reply(f.ready('new'));
  assert.equal(f.pending(), false);
});

test('an unconfirmed start re-queries status a bounded number of times and never re-sends start-take', async () => {
  const f = await recorderPage();
  const requestsBefore = f.sent.filter(m => m.type === 'take-status-request').length;
  f.record();
  for (let i = 0; i < 4; i += 1) f.advance(5_000);
  assert.equal(f.sent.filter(m => m.type === 'take-status-request').length - requestsBefore, 3);
  assert.equal(f.sent.filter(m => m.type === 'start-take').length, 1);
  assert.equal(f.pending(), false);
  assert.equal(f.window.relayRecordingState.commandError?.reason, 'unconfirmed');
});
