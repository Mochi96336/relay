import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeClock } from './support/fake-clock.js';

type Listener = (event: any) => void;

class FakeWindow {
  relayIdentityReady = Promise.resolve();
  relayProductAuthority: any = null;
  relayI18n = { t: (key: string) => key };
  relayParticipantId = 'self';
  relayParticipantCapability = 'capability';
  relayNickname = 'Singer';
  roomPresenceEvents: any[] = [];
  private listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatchEvent(event: any) {
    if (event.type === 'relay-room-mic-presence') this.roomPresenceEvents.push(event.detail);
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
    return true;
  }
}

class FakeNode {
  dataset: Record<string, string> = {};
  textContent = '';
  hidden = false;

  addEventListener() {}
}

class FakeEvent {
  constructor(public type: string) {}
}

class FakeCustomEvent extends FakeEvent {
  detail: any;

  constructor(type: string, init: { detail?: any } = {}) {
    super(type);
    this.detail = init.detail;
  }
}

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static latest: FakeWebSocket | null = null;

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  private listeners = new Map<string, Listener[]>();

  constructor(_url: string) {
    FakeWebSocket.latest = this;
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.dispatch('open', new FakeEvent('open'));
    });
  }

  addEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(payload: string) {
    this.sent.push(payload);
  }

  emit(payload: any) {
    this.dispatch('message', { type: 'message', data: JSON.stringify(payload) });
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatch('close', new FakeEvent('close'));
  }

  private dispatch(type: string, event: any) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function productStatus() {
  return {
    type: 'product-status',
    lifecycle: 'live',
    health: 'healthy',
    attention: null,
    room: {
      participantCount: 1,
      mic: {
        state: 'live',
        ownerId: 'self',
        ownerNickname: 'Singer',
      },
      song: { state: 'empty', videoId: null, handoffState: 'idle' },
    },
    timing: { state: 'aligned' },
    take: { lifecycle: 'idle' },
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function sentTypes(socket: FakeWebSocket) {
  return socket.sent.flatMap((payload) => {
    try { return [JSON.parse(payload).type]; } catch { return []; }
  });
}

test('OPEN status socket expires stale ProductStatus truth and a fresh snapshot restores it', async () => {
  const clock = new FakeClock();
  const fakeWindow = new FakeWindow();
  const body = new FakeNode();
  const nodes = new Map<string, FakeNode>([
    ['#live-state-title', new FakeNode()],
    ['#live-state-detail', new FakeNode()],
    ['#system-attention', new FakeNode()],
    ['#attention-link', new FakeNode()],
    ['#attention-copy', new FakeNode()],
    ['#system-panel', new FakeNode()],
    ['#system-relay', new FakeNode()],
    ['#system-phones', new FakeNode()],
    ['#system-robot', new FakeNode()],
    ['#system-audio', new FakeNode()],
    ['#system-timing', new FakeNode()],
    ['#system-recording', new FakeNode()],
  ]);
  const fakeDocument = {
    body,
    querySelector(selector: string) {
      return nodes.get(selector) ?? null;
    },
  };

  const globals = globalThis as any;
  const previous = {
    window: globals.window,
    document: globals.document,
    location: globals.location,
    WebSocket: globals.WebSocket,
    Event: globals.Event,
    CustomEvent: globals.CustomEvent,
    setTimeout: globals.setTimeout,
    clearTimeout: globals.clearTimeout,
    setInterval: globals.setInterval,
    clearInterval: globals.clearInterval,
  };

  globals.window = fakeWindow;
  globals.document = fakeDocument;
  globals.location = { protocol: 'http:', search: '', host: 'relay.test' };
  globals.WebSocket = FakeWebSocket;
  globals.Event = FakeEvent;
  globals.CustomEvent = FakeCustomEvent;
  globals.setTimeout = clock.setTimeout;
  globals.clearTimeout = clock.clearTimeout;
  globals.setInterval = clock.setInterval;
  globals.clearInterval = clock.clearInterval;

  try {
    const moduleUrl = new URL('../public/live-status.js', import.meta.url);
    moduleUrl.searchParams.set('freshness-test', `${Date.now()}-${Math.random()}`);
    await import(moduleUrl.href);
    await flush();

    const socket = FakeWebSocket.latest;
    assert.ok(socket, 'live-status should open its ProductStatus socket');
    assert.equal(socket.readyState, FakeWebSocket.OPEN);
    assert.equal(fakeWindow.relayProductAuthority.authorityFresh, false,
      'OPEN transport alone is not room-state authority');
    assert.equal(nodes.get('#live-state-title')?.textContent, 'system.unknown');
    assert.equal(nodes.get('#live-state-detail')?.textContent, 'system.connected');
    assert.ok(sentTypes(socket).includes('product-status-request'), 'status is requested immediately');

    socket.emit(productStatus());
    assert.equal(fakeWindow.relayProductAuthority.authorityFresh, true);
    assert.equal(nodes.get('#live-state-title')?.textContent, 'voice.live');
    assert.equal(body.dataset.roomMic, 'live');
    assert.equal(body.dataset.selfMic, 'live');
    assert.equal(nodes.get('#system-relay')?.textContent, 'system.connected');

    for (const [code, cause, key] of [
      ['robot-player-unavailable', 'robot-source-unavailable', 'system.attention.robot-source-disconnected'],
      ['robot-player-unavailable', 'robot-video-unplayable', 'system.attention.robot-video-unplayable'],
      ['mic-audio-stalled', 'mic-uplink-delayed', 'system.attention.mic-delayed'],
      ['timing-recovering', 'timing-fallback', 'system.attention.timing-estimate'],
    ]) {
      socket.emit({ ...productStatus(), health: 'degraded', attention: { code, scope: 'robot', severity: 'warning' },
        issues: [{ code, cause, scope: 'robot', severity: 'warning', recovery: 'automatic' }] });
      assert.equal(nodes.get('#attention-copy')?.textContent, key, 'the actual hero uses cause-specific copy');
    }
    const clockIssue = { code: 'song-clock-unavailable', scope: 'timing', severity: 'warning',
      cause: 'song-clock-unavailable', affects: ['timing'], recovery: 'check-playback' };
    socket.emit({ ...productStatus(), attention: clockIssue, issues: [clockIssue] });
    assert.equal(nodes.get('#system-audio')?.textContent, 'system.live',
      'missing progress alone must not mark healthy Mic audio as failed');
    assert.equal(nodes.get('#system-timing')?.textContent, 'system.attention.song-clock-unavailable',
      'stored alignment must not conceal missing current song observations');
    socket.emit({ ...productStatus(), attention: { ...clockIssue, scope: 'song' } });
    assert.equal(nodes.get('#system-audio')?.textContent, 'system.live',
      'legacy song-clock attention also describes missing observations, not failed audio');
    const audioIssue = { code: 'robot-audio-unavailable', scope: 'robot', severity: 'critical',
      affects: ['song', 'recording'] };
    socket.emit({ ...productStatus(), attention: clockIssue, issues: [clockIssue, audioIssue] });
    assert.equal(nodes.get('#system-robot')?.textContent, 'system.needsAttention');
    assert.equal(nodes.get('#system-audio')?.textContent, 'system.needsAttention',
      'independent audio faults remain visible even when attention names another issue');
    const micIssue = { code: 'mic-audio-stalled', scope: 'mic', severity: 'warning',
      cause: 'mic-uplink-delayed', affects: ['voice', 'recording'], recovery: 'automatic' };
    socket.emit({ ...productStatus(), attention: clockIssue, issues: [clockIssue, micIssue] });
    assert.equal(nodes.get('#system-audio')?.textContent, 'system.needsAttention',
      'Mic media degradation must affect Audio even when timing owns primary attention');
    assert.equal(nodes.get('#system-robot')?.textContent, 'system.ok',
      'Mic audio degradation must not imply Robot failure');
    socket.emit({ ...productStatus(), attention: { scope: 'mic', code: 'mic-audio-stalled' } });
    assert.equal(nodes.get('#system-audio')?.textContent, 'system.needsAttention',
      'legacy attention-only messages retain their fallback');
    socket.emit(productStatus());

    clock.advance(1_000);
    socket.emit(productStatus());
    assert.equal(fakeWindow.relayProductAuthority.authorityFresh, true,
      'a fresh snapshot resets the authority deadline');

    clock.advance(3_999);
    assert.equal(fakeWindow.relayProductAuthority.authorityFresh, true);
    assert.equal(nodes.get('#live-state-title')?.textContent, 'voice.live');

    clock.advance(1);
    assert.equal(socket.readyState, FakeWebSocket.OPEN,
      'the transport stays OPEN for this silent-status failure proof');
    assert.equal(fakeWindow.relayProductAuthority.authorityFresh, false);
    assert.equal(fakeWindow.relayProductAuthority.stale, true);
    assert.equal(nodes.get('#live-state-title')?.textContent, 'system.unknown',
      'stale room truth must stop claiming the singer is live');
    assert.equal(nodes.get('#live-state-detail')?.textContent, 'system.connected',
      'transport reachability remains a separate fact');
    assert.equal(nodes.get('#system-relay')?.textContent, 'system.connected');
    assert.equal(nodes.get('#system-audio')?.textContent, 'system.unknown');
    assert.equal(body.dataset.lifecycle, 'unknown');
    assert.equal(body.dataset.health, 'unknown');
    assert.equal(body.dataset.timing, 'unknown');
    assert.equal(body.dataset.roomMic, 'off');
    assert.equal(body.dataset.selfMic, 'off');
    assert.deepEqual(fakeWindow.roomPresenceEvents.at(-1), { active: false, ownerId: null },
      'stale authority also withdraws waveform/presence truth');
    assert.ok(sentTypes(socket).filter((type) => type === 'product-status-request').length >= 5,
      'polling keeps asking for room truth while responses are absent');

    socket.emit(productStatus());
    assert.equal(fakeWindow.relayProductAuthority.authorityFresh, true,
      'a fresh snapshot on the same socket restores authority');
    assert.equal(nodes.get('#live-state-title')?.textContent, 'voice.live');
    assert.equal(body.dataset.roomMic, 'live');
    assert.equal(body.dataset.selfMic, 'live');

    socket.close();
    assert.equal(nodes.get('#live-state-title')?.textContent, 'voice.connecting');
    assert.equal(nodes.get('#live-state-detail')?.textContent, '');
    assert.equal(nodes.get('#system-relay')?.textContent, 'system.reconnecting',
      'only transport loss is presented as reconnecting');
  } finally {
    globals.window = previous.window;
    globals.document = previous.document;
    globals.location = previous.location;
    globals.WebSocket = previous.WebSocket;
    globals.Event = previous.Event;
    globals.CustomEvent = previous.CustomEvent;
    globals.setTimeout = previous.setTimeout;
    globals.clearTimeout = previous.clearTimeout;
    globals.setInterval = previous.setInterval;
    globals.clearInterval = previous.clearInterval;
    FakeWebSocket.latest = null;
  }
});
