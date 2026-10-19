/** A page's open control socket: records what is sent and closes, and delivers JSON to listeners. */
export class EventSocket {
  readyState = 1;
  bufferedAmount = 0;
  sent: unknown[] = [];
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  private readonly listeners = new Map<string, Set<(event: { data: string }) => void>>();

  send(payload: unknown) {
    this.sent.push(payload);
  }

  close(code?: number, reason?: string) {
    this.closeCalls.push({ code, reason });
    this.readyState = 3;
  }

  addEventListener(type: string, listener: (event: { data: string }) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: { data: string }) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  emitJson(payload: unknown) {
    const event = { data: JSON.stringify(payload) };
    for (const listener of this.listeners.get('message') ?? []) listener(event);
  }
}
