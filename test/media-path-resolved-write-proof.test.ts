import assert from 'node:assert/strict';
import test from 'node:test';

const transportModuleUrl = new URL('../public/audio-transport.js', import.meta.url);

class FakeSocket {
  readyState = 1;
  bufferedAmount = 0;
  sent: unknown[] = [];

  send(payload: unknown) {
    this.sent.push(payload);
  }
}

class ResolvingDatagramWriter {
  desiredSize = 0;
  writes: Uint8Array[] = [];
  released = false;

  write(value: Uint8Array) {
    this.writes.push(new Uint8Array(value));
    return Promise.resolve();
  }

  releaseLock() {
    this.released = true;
  }
}

class ResolvingWebTransport {
  static instances: ResolvingWebTransport[] = [];
  readonly writer = new ResolvingDatagramWriter();
  readonly ready = Promise.resolve();
  readonly datagrams = {
    maxDatagramSize: 1200,
    outgoingHighWaterMark: 1,
    writable: { getWriter: () => this.writer },
  };
  readonly closed = new Promise<void>(() => {});
  closeCalls = 0;

  constructor(readonly url: string, readonly options: Record<string, unknown>) {
    ResolvingWebTransport.instances.push(this);
  }

  close() {
    this.closeCalls += 1;
  }
}

test('resolved WebTransport writes never satisfy the #287 unresolved-write stall detector', async () => {
  ResolvingWebTransport.instances.length = 0;
  const { PreferredAudioTransport } = await import(transportModuleUrl.href);
  let nowMs = 0;
  let serverAcceptedPackets = 0;
  const transport = new PreferredAudioTransport({
    minimumPacketBytes: 26,
    datagramWriteTimeoutMs: 1_000,
    WebTransportClass: ResolvingWebTransport,
    nowMs: () => nowMs,
  });
  const socket = new FakeSocket();
  transport.bind(socket);
  assert.equal(await transport.prefer({
    preferred: 'webtransport',
    url: 'https://media.example.test:4433/media?ticket=resolved-drop',
  }), true);

  const first = transport.send(new Uint8Array(100).buffer);
  assert.equal(first.sent, true);
  assert.equal(first.path, 'webtransport');
  await Promise.resolve();
  await Promise.resolve();

  // The fixture deliberately supplies no server-receive evidence at all. The
  // local writer has nevertheless settled, so #287 must not classify this as
  // an unresolved-write stall or silently turn sender completion into receipt.
  assert.equal(serverAcceptedPackets, 0);
  nowMs = 10_000;
  const second = transport.send(new Uint8Array(100).buffer);
  assert.equal(second.sent, true);
  assert.equal(second.path, 'webtransport');
  await Promise.resolve();
  await Promise.resolve();

  const instance = ResolvingWebTransport.instances.at(-1)!;
  const stats = transport.stats();
  assert.equal(instance.writer.writes.length, 2);
  assert.equal(instance.closeCalls, 0);
  assert.equal(stats.path, 'webtransport');
  assert.equal(stats.webTransportPacketsSubmitted, 2);
  assert.equal(stats.webTransportDemotions, 0);
  assert.equal(stats.webTransportCongestedRejects, 0);
  assert.equal(stats.webTransportSendFailures, 0);
  assert.equal(socket.sent.length, 0, 'resolved writes do not cause WebSocket fallback');
  assert.equal(serverAcceptedPackets, 0, 'sender completion remains independent of server PCM progress');
});
