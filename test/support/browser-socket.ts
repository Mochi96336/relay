import WebSocket from 'ws';

/** A page's open control WebSocket: records closes, delivers text messages to listeners. */
export class BrowserSocket {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  private readonly listeners = new Map<string, Set<(event: { data: string }) => void>>();

  constructor(private readonly onSend: (payload: unknown) => void) {}

  send(payload: unknown) {
    this.onSend(payload);
  }

  close(code?: number, reason?: string) {
    this.closeCalls.push({ code, reason });
    this.readyState = WebSocket.CLOSED;
  }

  addEventListener(type: string, listener: (event: { data: string }) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: { data: string }) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  emitText(data: string) {
    for (const listener of this.listeners.get('message') ?? []) listener({ data });
  }
}
