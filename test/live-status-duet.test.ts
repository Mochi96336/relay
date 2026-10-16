import assert from 'node:assert/strict';
import test from 'node:test';

type Listener = (event: any) => void;

class FakeWindow {
  relayIdentityReady = Promise.resolve();
  relayProductAuthority: any = null;
  relayI18n = { t: (key: string, vars?: Record<string, string>) => vars ? `${key}${JSON.stringify(vars)}` : key };
  relayParticipantId = 'viewer';
  relayParticipantCapability = 'capability';
  relayNickname = 'Interaction Viewer';
  private listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatchEvent(event: any) {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
    return true;
  }
}

class FakeNode {
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  attributes = new Map<string, string>();
  classList = { add() {} };
  children: FakeNode[] = [];
  textContent = '';
  hidden = false;

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  append(...nodes: FakeNode[]) {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes: FakeNode[]) {
    this.children = [...nodes];
  }

  /** The meter's waveform path, painted by index.html. */
  querySelector(selector: string): FakeNode | null {
    if (selector !== '.voice-presence-wave') return null;
    this.children[0] ??= new FakeNode();
    return this.children[0];
  }

  addEventListener() {}
}

class FakeEvent {
  type: string;

  constructor(type: string) {
    this.type = type;
  }
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

  send(_data: string) {}

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatch('close', new FakeEvent('close'));
  }

  emit(payload: any) {
    this.dispatch('message', {
      type: 'message',
      data: JSON.stringify(payload),
    });
  }

  private dispatch(type: string, event: any) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function productStatus(ownerId: string, duet: Record<string, unknown> | null) {
  return {
    type: 'product-status',
    lifecycle: 'live',
    health: 'healthy',
    attention: null,
    room: {
      participantCount: 3,
      mic: { state: 'live', ownerId, ownerNickname: 'Singer A' },
      ...(duet ? { duet } : {}),
      song: { state: 'empty', videoId: null, handoffState: 'idle' },
    },
    timing: { state: 'idle' },
    take: { lifecycle: 'idle' },
  };
}

async function flush() {
  for (let i = 0; i < 3; i += 1) await Promise.resolve();
}

test('the heading names the second singer for the owner, the second singer and everyone else', async () => {
  const fakeWindow = new FakeWindow();
  const title = new FakeNode();
  const detail = new FakeNode();
  const nodes = new Map<string, FakeNode>([
    ['#live-state-title', title], ['#live-state-detail', detail],
    ['#system-attention', new FakeNode()], ['#attention-link', new FakeNode()],
    ['#attention-copy', new FakeNode()], ['#system-panel', new FakeNode()],
    ['#system-relay', new FakeNode()], ['#system-phones', new FakeNode()],
    ['#system-robot', new FakeNode()], ['#system-audio', new FakeNode()],
    ['#system-timing', new FakeNode()], ['#system-recording', new FakeNode()],
    ['#mic-input-meter', new FakeNode()],
  ]);
  const globals = globalThis as any;
  const previous = { window: globals.window, document: globals.document, location: globals.location,
    WebSocket: globals.WebSocket, Event: globals.Event, CustomEvent: globals.CustomEvent };
  globals.window = fakeWindow;
  globals.document = { body: new FakeNode(), querySelector: (s: string) => nodes.get(s) ?? null };
  globals.location = { protocol: 'http:', search: '', host: 'relay.test' };
  globals.WebSocket = FakeWebSocket;
  globals.Event = FakeEvent;
  globals.CustomEvent = FakeCustomEvent;
  try {
    const statusModule = new URL('../public/live-status.js', import.meta.url);
    statusModule.searchParams.set('live-status-duet-test', `${Date.now()}-${Math.random()}`);
    await import(statusModule.href);
    await flush();
    const socket = FakeWebSocket.latest!;
    const duet = (state: string, secondaryId = 'viewer') => ({ secondaryId, secondaryNickname: '小明', state });

    // The second singer sees who they are singing with and how far along they are.
    for (const state of ['joined', 'aligning', 'singing']) {
      socket.emit(productStatus('owner', duet(state)));
      assert.equal(title.textContent, 'voice.duetYours{"name":"Singer A"}');
      assert.equal(detail.textContent, `voice.duet.self.${state}`);
    }

    // The Mic owner keeps "you are singing" and sees who joined.
    fakeWindow.relayParticipantId = 'owner';
    for (const state of ['joined', 'aligning', 'singing']) {
      socket.emit(productStatus('owner', duet(state, 'friend')));
      assert.equal(title.textContent, 'voice.live');
      assert.equal(detail.textContent, `voice.duet.owner.${state}{"name":"小明"}`);
    }

    // Everyone else sees both names only once both voices are in the room.
    fakeWindow.relayParticipantId = 'listener';
    socket.emit(productStatus('owner', duet('aligning', 'friend')));
    assert.equal(title.textContent, 'Singer A');
    assert.equal(detail.textContent, 'voice.singing');
    socket.emit(productStatus('owner', duet('singing', 'friend')));
    assert.equal(title.textContent, 'voice.duetPair{"owner":"Singer A","partner":"小明"}');
    assert.equal(detail.textContent, 'voice.singing');

    // No duet: the ordinary heading.
    socket.emit(productStatus('owner', null));
    assert.equal(title.textContent, 'Singer A');
    assert.equal(detail.textContent, 'voice.singing');
  } finally {
    Object.assign(globals, previous);
    FakeWebSocket.latest = null;
  }
});
