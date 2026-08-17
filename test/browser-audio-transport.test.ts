import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

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
  released = false;

  async write(value: Uint8Array) {
    this.writes.push(new Uint8Array(value));
  }

  releaseLock() {
    this.released = true;
  }
}

class FakeWebTransport {
  static instances: FakeWebTransport[] = [];
  readonly writer = new FakeDatagramWriter();
  readonly ready = Promise.resolve();
  readonly datagrams = {
    maxDatagramSize: 1200,
    writable: { getWriter: () => this.writer },
  };
  readonly url: string;
  readonly options: Record<string, unknown>;
  readonly closed: Promise<void>;
  private resolveClosed!: () => void;

  constructor(url: string, options: Record<string, unknown>) {
    this.url = url;
    this.options = options;
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    FakeWebTransport.instances.push(this);
  }

  close() {
    this.resolveClosed();
  }
}

class TooSmallWebTransport {
  readonly writer = new FakeDatagramWriter();
  readonly ready = Promise.resolve();
  readonly datagrams = {
    maxDatagramSize: 25,
    writable: { getWriter: () => this.writer },
  };
  readonly closed = new Promise<void>(() => {});

  close() {}
}

describe('browser AudioTransport', () => {
  it('owns WebSocket media send readiness and congestion instead of capture code', async () => {
    const { WebSocketAudioTransport } = await import(moduleUrl.href);
    const transport = new WebSocketAudioTransport({ maxBufferedBytes: 10 });
    const socket = new FakeSocket();

    assert.equal(transport.maxPacketBytes(), Number.POSITIVE_INFINITY);
    assert.equal(transport.send('before').reason, 'disconnected');

    transport.bind(socket);
    assert.equal(transport.send('first').sent, true);
    assert.deepEqual(socket.sent, ['first']);

    socket.bufferedAmount = 10;
    const congested = transport.send('second');
    assert.equal(congested.sent, false);
    assert.equal(congested.reason, 'congested');
    assert.deepEqual(socket.sent, ['first']);
  });

  it('cannot let a stale reconnect close detach the replacement WebSocket fallback', async () => {
    const { WebSocketAudioTransport } = await import(moduleUrl.href);
    const transport = new WebSocketAudioTransport();
    const previous = new FakeSocket();
    const replacement = new FakeSocket();

    transport.bind(previous);
    transport.bind(replacement);
    transport.unbind(previous);
    assert.equal(transport.send('live').sent, true);
    assert.deepEqual(replacement.sent, ['live']);
  });

  it('prefers one unreliable WebTransport datagram path without duplicating onto WebSocket', async () => {
    FakeWebTransport.instances.length = 0;
    const { PreferredAudioTransport } = await import(moduleUrl.href);
    const transport = new PreferredAudioTransport({
      minimumPacketBytes: 26,
      WebTransportClass: FakeWebTransport,
    });
    const socket = new FakeSocket();
    transport.bind(socket);

    const preferred = await transport.prefer({
      preferred: 'webtransport',
      url: 'https://media.example.test:4433/media?ticket=abc',
      serverCertificateHashes: [{ algorithm: 'sha-256', valueBase64: 'AQIDBA==' }],
    });
    assert.equal(preferred, true);
    assert.equal(transport.maxPacketBytes(), 1200);

    const instance = FakeWebTransport.instances.at(-1)!;
    assert.equal(instance.options.requireUnreliable, true);
    assert.equal(instance.options.congestionControl, 'low-latency');
    const hashes = instance.options.serverCertificateHashes as Array<{ value: Uint8Array }>;
    assert.deepEqual(Array.from(hashes[0].value), [1, 2, 3, 4]);

    const packet = new Uint8Array([5, 6, 7]).buffer;
    const result = transport.send(packet);
    await Promise.resolve();
    assert.equal(result.sent, true);
    assert.equal(result.path, 'webtransport');
    assert.deepEqual(instance.writer.writes.map((value) => Array.from(value)), [[5, 6, 7]]);
    assert.deepEqual(socket.sent, []);
  });

  it('rejects a datagram larger than the live path budget without silently retransmitting it over WebSocket', async () => {
    const { PreferredAudioTransport } = await import(moduleUrl.href);
    const transport = new PreferredAudioTransport({
      minimumPacketBytes: 26,
      WebTransportClass: FakeWebTransport,
    });
    const socket = new FakeSocket();
    transport.bind(socket);
    await transport.prefer({
      preferred: 'webtransport',
      url: 'https://media.example.test:4433/media?ticket=mtu',
    });

    const instance = FakeWebTransport.instances.at(-1)!;
    const result = transport.send(new Uint8Array(1201).buffer);
    assert.equal(result.sent, false);
    assert.equal(result.reason, 'packet-too-large');
    assert.equal(result.maxPacketBytes, 1200);
    assert.deepEqual(instance.writer.writes, []);
    assert.deepEqual(socket.sent, []);
  });

  it('refuses a preferred path whose datagram budget cannot hold one application packet', async () => {
    const { PreferredAudioTransport } = await import(moduleUrl.href);
    const transport = new PreferredAudioTransport({
      minimumPacketBytes: 26,
      WebTransportClass: TooSmallWebTransport,
    });
    const socket = new FakeSocket();
    transport.bind(socket);

    assert.equal(await transport.prefer({
      preferred: 'webtransport',
      url: 'https://media.example.test:4433/media?ticket=tiny',
    }), false);
    assert.equal(transport.maxPacketBytes(), Number.POSITIVE_INFINITY);
    assert.equal(transport.send('fallback').path, 'websocket');
    assert.deepEqual(socket.sent, ['fallback']);
  });

  it('drops a backpressured datagram instead of duplicating the same packet over WebSocket', async () => {
    const { PreferredAudioTransport } = await import(moduleUrl.href);
    const transport = new PreferredAudioTransport({ WebTransportClass: FakeWebTransport });
    const socket = new FakeSocket();
    transport.bind(socket);
    await transport.prefer({
      preferred: 'webtransport',
      url: 'https://media.example.test:4433/media?ticket=pressure',
    });

    const instance = FakeWebTransport.instances.at(-1)!;
    instance.writer.desiredSize = 0;
    const result = transport.send(new Uint8Array([1]).buffer);
    assert.equal(result.sent, false);
    assert.equal(result.reason, 'congested');
    assert.equal(result.path, 'webtransport');
    assert.deepEqual(socket.sent, []);
  });

  it('falls back on the next packet after the preferred transport closes', async () => {
    const { PreferredAudioTransport } = await import(moduleUrl.href);
    const transport = new PreferredAudioTransport({ WebTransportClass: FakeWebTransport });
    const socket = new FakeSocket();
    transport.bind(socket);
    await transport.prefer({
      preferred: 'webtransport',
      url: 'https://media.example.test:4433/media?ticket=fallback',
    });

    const instance = FakeWebTransport.instances.at(-1)!;
    transport.send(new Uint8Array([1]).buffer);
    instance.close();
    await Promise.resolve();
    await Promise.resolve();

    const next = new Uint8Array([2]).buffer;
    const result = transport.send(next);
    assert.equal(result.sent, true);
    assert.equal(result.path, 'websocket');
    assert.deepEqual(socket.sent, [next]);
  });

  it('uses WebSocket when native WebTransport is unavailable', async () => {
    const { PreferredAudioTransport } = await import(moduleUrl.href);
    const transport = new PreferredAudioTransport({ WebTransportClass: undefined });
    const socket = new FakeSocket();
    transport.bind(socket);

    assert.equal(await transport.prefer({
      preferred: 'webtransport',
      url: 'https://media.example.test:4433/media?ticket=unsupported',
    }), false);
    assert.equal(transport.send('fallback').path, 'websocket');
    assert.deepEqual(socket.sent, ['fallback']);
  });

  it('keeps control WebSocket sends separate from media sends in app.js', () => {
    const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
    assert.match(app, /new PreferredAudioTransport/);
    assert.match(app, /splitPcmForPacketLimit/);
    assert.match(app, /audioTransport\.maxPacketBytes\(\)/);
    assert.match(app, /audioTransport\.send\(/);
    assert.match(app, /audioTransport\.prefer\(/);
    assert.doesNotMatch(app, /socket\.send\(framePcm\(/);
    assert.doesNotMatch(app, /framePcm\(event\.data/);
  });
});
