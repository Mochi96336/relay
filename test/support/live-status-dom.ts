/**
 * A page for live-status.js to run in: the window, nodes, events and the
 * one WebSocket it opens (FakeWebSocket.latest), with nothing else.
 */
export type Listener = (event: any) => void;

export class FakeWindow {
  relayIdentityReady = Promise.resolve();
  relayProductAuthority: any = null;
  relayI18n: { t: (key: string, vars?: Record<string, string>) => string };
  relayParticipantId: string;
  relayParticipantCapability = 'capability';
  relayNickname = 'Interaction Viewer';
  private listeners = new Map<string, Listener[]>();

  constructor({ participantId = 'viewer', t = (key: string) => key }: {
    participantId?: string;
    t?: (key: string, vars?: Record<string, string>) => string;
  } = {}) {
    this.relayParticipantId = participantId;
    this.relayI18n = { t };
  }

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

export class FakeNode {
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

export class FakeEvent {
  type: string;

  constructor(type: string) {
    this.type = type;
  }
}

export class FakeCustomEvent extends FakeEvent {
  detail: any;

  constructor(type: string, init: { detail?: any } = {}) {
    super(type);
    this.detail = init.detail;
  }
}

export class FakeWebSocket {
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
