import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const CLAIM = 'c'.repeat(64);

async function fixture({ direct = false } = {}) {
  let now = 0;
  let timerId = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const events: Array<{ type: string; detail?: any }> = [];
  const listeners = new Map<string, Array<(event: any) => void>>();
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 0;
    sent: any[] = [];
    private handlers = new Map<string, Array<(event: any) => void>>();
    constructor(public url: string) { sockets.push(this); }
    addEventListener(type: string, fn: (event: any) => void) {
      this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
    }
    send(data: string) { this.sent.push(JSON.parse(data)); }
    close() {
      if (this.readyState === FakeSocket.CLOSED) return;
      this.readyState = FakeSocket.CLOSED;
      for (const fn of this.handlers.get('close') ?? []) fn({});
    }
    open() {
      this.readyState = FakeSocket.OPEN;
      for (const fn of this.handlers.get('open') ?? []) fn({});
    }
    reply(message: unknown) {
      for (const fn of this.handlers.get('message') ?? []) fn({ data: JSON.stringify(message) });
    }
  }
  class Capture {
    rate: number | null = null;
    async prepare() { this.rate = 48_000; return this.rate; }
    attach() { return true; }
    stop() { this.rate = null; }
    anchorFor() { return null; }
  }
  const window: any = {
    relayParticipantId: 'participant-b',
    addEventListener(type: string, fn: (event: any) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    dispatchEvent(event: any) {
      events.push(event);
      for (const fn of listeners.get(event.type) ?? []) fn(event);
    },
  };
  const source = (await readFile(new URL('../public/choir-secondary-media-client.js', import.meta.url), 'utf8'))
    .replace(/^import[^\n]*\n/gm, '');
  vm.runInNewContext(source, {
    window, WebSocket: FakeSocket, ChoirSecondaryCapture: Capture,
    wsUrl: ({ direct: viaDirect = false } = {}) => (viaDirect && direct ? 'wss://pi.test/ws' : 'wss://relay.test/ws'),
    sendParticipantAuthentication: (socket: FakeSocket) => { socket.send(JSON.stringify({ type: 'participant-authenticate' })); return true; },
    MIC_GAIN_KEY: 'mic-gain', storedNumber: () => null,
    performance: { now: () => now },
    Event: class { constructor(public type: string) {} },
    CustomEvent: class { detail: any; constructor(public type: string, init: any) { this.detail = init.detail; } },
    setTimeout: (run: () => void, delay: number) => { timers.set(++timerId, { at: now + delay, run }); return timerId; },
    clearTimeout: (id: number) => timers.delete(id),
  });
  const emit = (type: string, detail?: unknown) => window.dispatchEvent({ type, detail });
  const claims = () => events.filter((e) => e.type === 'relay-choir-consent-command'
    && e.detail?.type === 'choir-secondary-media-claim-request').length;
  const connection = () => events.filter((e) => e.type === 'relay-choir-media-connection').map((e) => e.detail);
  return {
    sockets, emit, claims, connection,
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.run(); }
    },
    async join(roomEpoch = 1) {
      emit('relay-choir-media-mode', { enabled: true });
      emit('relay-choir-start-secondary-capture');
      await new Promise((resolve) => setImmediate(resolve));
      emit('relay-choir-media-message', { type: 'choir-room-ready', roomEpoch });
      emit('relay-choir-media-message', { type: 'choir-secondary-media-claim', claimToken: CLAIM, roomEpoch });
    },
  };
}

test('an open media socket the server never registers is dropped, and the next room-ready claims again', async () => {
  const f = await fixture();
  await f.join();
  assert.equal(f.claims(), 1);
  const socket = f.sockets.at(-1)!;
  socket.open();
  assert.equal(socket.sent[0].type, 'participant-authenticate');
  // The server goes quiet: no participant-authenticated, no registration.
  f.emit('relay-choir-media-message', { type: 'choir-room-ready', roomEpoch: 1 });
  assert.equal(f.claims(), 1, 'a repeated room-ready does not disturb a socket still in its deadline');
  f.advance(5_000);
  assert.equal(socket.readyState, 3, 'the silent socket is closed');
  assert.equal(f.connection().at(-1).state, 'disconnected');
  assert.equal(f.connection().at(-1).reason, 'register-timeout');
  f.emit('relay-choir-media-message', { type: 'choir-room-ready', roomEpoch: 1 });
  assert.equal(f.claims(), 2, 'the server\'s next room-ready brings a fresh claim');
});

test('a socket stalled after authentication is dropped too, but a registered one is kept', async () => {
  const f = await fixture();
  await f.join();
  const stalled = f.sockets.at(-1)!;
  stalled.open();
  stalled.reply({ type: 'participant-authenticated', participantId: 'participant-b' });
  assert.equal(stalled.sent.at(-1).type, 'choir-secondary-media-register');
  f.advance(5_000);
  assert.equal(stalled.readyState, 3);

  f.emit('relay-choir-media-message', { type: 'choir-room-ready', roomEpoch: 1 });
  f.emit('relay-choir-media-message', { type: 'choir-secondary-media-claim', claimToken: CLAIM, roomEpoch: 1 });
  const healthy = f.sockets.at(-1)!;
  assert.notEqual(healthy, stalled);
  healthy.open();
  healthy.reply({ type: 'participant-authenticated', participantId: 'participant-b' });
  healthy.reply({ type: 'choir-secondary-media-registered', roomEpoch: 1, awaitingContent: true, sampleRate: 48_000 });
  f.advance(60_000);
  assert.equal(healthy.readyState, 1, 'a registered socket has no deadline');
  assert.equal(f.connection().at(-1).state, 'registered');
});

test('a direct socket that opens but goes quiet sends the next claim through the tunnel', async () => {
  const f = await fixture({ direct: true });
  await f.join();
  const direct = f.sockets.at(-1)!;
  assert.equal(direct.url, 'wss://pi.test/ws');
  direct.open();
  f.advance(5_000);
  f.emit('relay-choir-media-message', { type: 'choir-room-ready', roomEpoch: 1 });
  f.emit('relay-choir-media-message', { type: 'choir-secondary-media-claim', claimToken: CLAIM, roomEpoch: 1 });
  assert.equal(f.sockets.at(-1)!.url, 'wss://relay.test/ws');
});

test('with no song, media-ready connects B at once, and a repeat never replaces that socket', async () => {
  const f = await fixture();
  f.emit('relay-choir-media-mode', { enabled: true });
  f.emit('relay-choir-start-secondary-capture');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.claims(), 0, 'nothing is claimed until the server asks');

  f.emit('relay-choir-media-message', { type: 'choir-media-ready' });
  assert.equal(f.claims(), 1);
  // A join claim names no room.
  f.emit('relay-choir-media-message', { type: 'choir-secondary-media-claim', claimToken: CLAIM, roomEpoch: null });
  const socket = f.sockets.at(-1)!;
  socket.open();
  socket.reply({ type: 'participant-authenticated', participantId: 'participant-b' });
  assert.equal(socket.sent.at(-1).type, 'choir-secondary-media-register');
  socket.reply({ type: 'choir-secondary-media-registered', roomEpoch: null, awaitingContent: true });
  assert.equal(f.connection().at(-1).state, 'registered');

  // The server repeats media-ready only until B is connected; a repeat in
  // flight never replaces the socket B has.
  f.emit('relay-choir-media-message', { type: 'choir-media-ready' });
  assert.equal(f.claims(), 1);
  assert.equal(f.sockets.length, 1);
  assert.notEqual(socket.readyState, 3, 'still connected');
});
