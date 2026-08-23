import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const moduleUrl = new URL('../public/audio-transport.js', import.meta.url);

class DeferredDatagramWriter {
  writes: Uint8Array[] = [];
  private pending: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];

  write(value: Uint8Array) {
    this.writes.push(new Uint8Array(value));
    return new Promise<void>((resolve, reject) => {
      this.pending.push({ resolve, reject });
    });
  }

  resolve(index = 0) {
    this.pending[index]?.resolve();
  }

  reject(index = 0, message = 'datagram failed') {
    this.pending[index]?.reject(new Error(message));
  }

  releaseLock() {}
}

class DeferredWebTransport {
  static instances: DeferredWebTransport[] = [];
  readonly writer = new DeferredDatagramWriter();
  readonly ready = Promise.resolve();
  readonly datagrams = {
    maxDatagramSize: 65_535,
    writable: { getWriter: () => this.writer },
  };
  readonly closed: Promise<void>;
  private resolveClosed!: () => void;
  private isClosed = false;

  constructor(readonly url: string) {
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    DeferredWebTransport.instances.push(this);
  }

  close() {
    if (this.isClosed) return;
    this.isClosed = true;
    this.resolveClosed();
  }
}

const offer = (ticket: string) => ({
  preferred: 'webtransport',
  url: `https://media.example.test:4433/media?ticket=${ticket}`,
});

describe('WebTransport write generation ownership', () => {
  it('keeps pending writes authoritative when a control reconnect re-advertises the same media session', async () => {
    DeferredWebTransport.instances.length = 0;
    const { PreferredAudioTransport } = await import(moduleUrl.href);
    const transport = new PreferredAudioTransport({
      datagramQueuePackets: 1,
      WebTransportClass: DeferredWebTransport,
    });

    assert.equal(await transport.prefer(offer('same')), true);
    const retained = DeferredWebTransport.instances.at(-1)!;
    assert.equal(transport.send(new Uint8Array(100).buffer).sent, true);

    // Relay preserves the media ticket across a same-capture control WebSocket
    // reconnect. Re-advertising that same URL retains the same WT writer, so it
    // must also retain the generation that owns its pending write promises.
    assert.equal(await transport.prefer(offer('same')), true);
    assert.equal(DeferredWebTransport.instances.length, 1);
    assert.equal(transport.stats().webTransportAttempts, 1);
    assert.equal(transport.stats().webTransportConnections, 1);

    retained.writer.reject(0, 'retained-session failure');
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(transport.stats().path, 'websocket');
    assert.equal(transport.stats().webTransportSendFailures, 1);
    assert.equal(transport.stats().webTransportDemotions, 1);
  });

  it('does not let a stale completion from a replaced session decrement the replacement outstanding budget', async () => {
    DeferredWebTransport.instances.length = 0;
    const { PreferredAudioTransport } = await import(moduleUrl.href);
    const transport = new PreferredAudioTransport({
      datagramQueuePackets: 1,
      WebTransportClass: DeferredWebTransport,
    });

    await transport.prefer(offer('old'));
    const oldTransport = DeferredWebTransport.instances.at(-1)!;
    assert.equal(transport.send(new Uint8Array(100).buffer).sent, true);

    await transport.prefer(offer('new'));
    const replacement = DeferredWebTransport.instances.at(-1)!;
    assert.notEqual(replacement, oldTransport);
    assert.equal(transport.send(new Uint8Array(100).buffer).sent, true);

    oldTransport.writer.reject(0, 'late old-session failure');
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(transport.stats().path, 'webtransport');
    assert.equal(transport.stats().webTransportSendFailures, 0);
    assert.equal(transport.stats().webTransportDemotions, 0);
    assert.equal(
      transport.send(new Uint8Array(100).buffer).reason,
      'congested',
      'the replacement write is still pending; a stale old completion must not free its slot',
    );

    replacement.writer.resolve(0);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(transport.send(new Uint8Array(100).buffer).sent, true);
  });
});
