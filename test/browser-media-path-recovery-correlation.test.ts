import assert from 'node:assert/strict';
import test from 'node:test';

const moduleUrl = new URL('../public/audio-transport.js', import.meta.url);

class EventSocket {
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

class FakeDatagramWriter {
  async write(_value: Uint8Array) {}
  releaseLock() {}
}

class FakeWebTransport {
  static instances: FakeWebTransport[] = [];
  readonly writer = new FakeDatagramWriter();
  readonly ready = Promise.resolve();
  readonly datagrams = {
    maxDatagramSize: 1_200,
    writable: { getWriter: () => this.writer },
  };
  readonly closed: Promise<void>;
  closeCalls = 0;
  private resolveClosed!: () => void;

  constructor(readonly url: string) {
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    FakeWebTransport.instances.push(this);
  }

  close() {
    this.closeCalls += 1;
    this.resolveClosed();
  }
}

function health(
  capturedSamples: number,
  path: 'webtransport' | 'websocket' = 'webtransport',
) {
  return {
    type: 'audio-uplink-health',
    version: 1,
    captureGeneration: 7,
    capturedSamples,
    transport: { path },
  };
}

function ack(
  acceptedFrameSerial: number,
  mediaPath: 'webtransport' | 'websocket' | null = 'webtransport',
) {
  return {
    type: 'audio-uplink-health-ack',
    version: 1,
    captureGeneration: 7,
    pcm: { acceptedFrameSerial, mediaPath },
  };
}

async function webTransportFixture() {
  FakeWebTransport.instances.length = 0;
  const { PreferredAudioTransport } = await import(moduleUrl.href);
  const transport = new PreferredAudioTransport({ WebTransportClass: FakeWebTransport });
  const socket = new EventSocket();
  transport.bind(socket);
  assert.equal(await transport.prefer({
    preferred: 'webtransport',
    url: 'https://relay.test/media',
  }), true);
  return { transport, socket };
}

test('delayed ACKs keep the captured-sample frontier from the health report they acknowledge', async () => {
  const { transport, socket } = await webTransportFixture();

  // Four reports were emitted while the local capture clock was not moving.
  // Hold their ACKs so newer local progress exists by the time they arrive.
  for (let index = 0; index < 4; index += 1) {
    assert.equal(transport.sendControlJson(health(1_000)).sent, true);
  }

  for (const capturedSamples of [1_100, 1_200, 1_300, 1_400]) {
    assert.equal(transport.sendControlJson(health(capturedSamples)).sent, true);
    socket.emitJson(ack(10));
  }

  // The four ACKs above correspond to capturedSamples=1000. They must not be
  // reinterpreted using the newer local frontier and therefore cannot demote WT.
  assert.equal(transport.stats().path, 'webtransport');
  assert.equal(socket.closeCalls.length, 0);
  assert.equal(FakeWebTransport.instances[0].closeCalls, 0);

  // Once ACKs for the genuinely advancing reports drain, three consecutive
  // current-generation stale observations are again allowed to demote WT.
  socket.emitJson(ack(10));
  socket.emitJson(ack(10));
  socket.emitJson(ack(10));
  assert.equal(transport.stats().path, 'websocket');
  assert.equal(FakeWebTransport.instances[0].closeCalls, 1);
});

test('background eligibility is captured when health is sent, not when its ACK arrives', async () => {
  const { transport, socket } = await webTransportFixture();
  const previousDocument = (globalThis as { document?: unknown }).document;

  Object.defineProperty(globalThis, 'document', {
    value: { visibilityState: 'hidden' },
    configurable: true,
  });
  try {
    for (const capturedSamples of [1_000, 1_100, 1_200, 1_300]) {
      assert.equal(transport.sendControlJson(health(capturedSamples)).sent, true);
    }

    // Return to foreground before the delayed ACKs drain. Historical hidden
    // observations must stay ineligible instead of becoming a media verdict.
    Object.defineProperty(globalThis, 'document', {
      value: { visibilityState: 'visible' },
      configurable: true,
    });
    for (let index = 0; index < 4; index += 1) socket.emitJson(ack(10));

    assert.equal(transport.stats().path, 'webtransport');
    assert.equal(socket.closeCalls.length, 0);
    assert.equal(FakeWebTransport.instances[0].closeCalls, 0);
  } finally {
    if (previousDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else Object.defineProperty(globalThis, 'document', {
      value: previousDocument,
      configurable: true,
    });
  }
});

test('WT-era ACKs cannot spend the WebSocket replacement budget after another owner demotes WT', async () => {
  const { transport, socket } = await webTransportFixture();

  for (const capturedSamples of [1_000, 1_100, 1_200, 1_300]) {
    assert.equal(transport.sendControlJson(health(capturedSamples, 'webtransport')).sent, true);
  }

  // Model #287 or another transport owner demoting WT before these already-sent
  // health reports receive their ordered ACKs.
  transport.demoteWebTransport();
  assert.equal(transport.stats().path, 'websocket');

  for (let index = 0; index < 4; index += 1) socket.emitJson(ack(10, 'webtransport'));

  // Historical WT observations may corroborate the WT failure/quarantine, but
  // they must never be relabelled as WebSocket observations and close control.
  assert.equal(socket.closeCalls.length, 0);
  assert.equal(transport.stats().path, 'websocket');
});
