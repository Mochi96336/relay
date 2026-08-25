import assert from 'node:assert/strict';
import test from 'node:test';

const moduleUrl = new URL('../public/audio-transport.js', import.meta.url);

class FakeSocket {
  readyState = 1;
  bufferedAmount = 0;
  sent: unknown[] = [];

  send(payload: unknown) {
    this.sent.push(payload);
  }
}

class FakeDatagramWriter {
  desiredSize = 1;
  writes: Uint8Array[] = [];

  async write(value: Uint8Array) {
    this.writes.push(new Uint8Array(value));
  }

  releaseLock() {}
}

class FakeWebTransport {
  static instances: FakeWebTransport[] = [];
  readonly writer = new FakeDatagramWriter();
  readonly ready = Promise.resolve();
  readonly datagrams = {
    maxDatagramSize: 1200,
    writable: { getWriter: () => this.writer },
  };
  readonly closed: Promise<void>;
  private resolveClosed!: () => void;

  constructor(_url: string, _options: Record<string, unknown>) {
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    FakeWebTransport.instances.push(this);
  }

  close() {
    this.resolveClosed();
  }
}

test('transport telemetry survives control reconnect and resets only for a fresh capture', async () => {
  FakeWebTransport.instances.length = 0;
  const { PreferredAudioTransport } = await import(moduleUrl.href);
  const transport = new PreferredAudioTransport({
    minimumPacketBytes: 26,
    // Depth 1 so the second datagram below is refused as congestion. Backpressure
    // counts datagrams still in flight rather than reading the writable stream's
    // desiredSize, which only reports whether a write is outstanding.
    datagramQueuePackets: 1,
    WebTransportClass: FakeWebTransport,
  });
  const socket = new FakeSocket();
  transport.bind(socket);

  await transport.prefer({
    preferred: 'webtransport',
    url: 'https://media.example.test:4433/media?ticket=stats',
  });
  const instance = FakeWebTransport.instances.at(-1)!;
  transport.send(new Uint8Array([1, 2, 3]).buffer);
  transport.send(new Uint8Array([4]).buffer);
  instance.close();
  await Promise.resolve();
  await Promise.resolve();

  transport.send(new Uint8Array([5]).buffer);
  const stats = transport.stats();
  assert.equal(stats.path, 'websocket');
  assert.equal(stats.webTransportAttempts, 1);
  assert.equal(stats.webTransportConnections, 1);
  assert.equal(stats.webTransportDemotions, 1);
  assert.equal(stats.webTransportPacketsSubmitted, 1);
  assert.equal(stats.webTransportCongestedRejects, 1);
  assert.equal(stats.minWebTransportMaxPacketBytes, 1200);
  assert.equal(stats.maxWebTransportMaxPacketBytes, 1200);
  assert.equal(stats.webSocketPacketsSent, 1);

  const replacement = new FakeSocket();
  transport.bind(replacement);
  assert.equal(transport.stats().webTransportAttempts, 1, 'control reconnect does not reset capture stats');

  transport.resetStats();
  assert.equal(transport.stats().webTransportAttempts, 0);
  assert.equal(transport.stats().webSocketPacketsSent, 0);
});
