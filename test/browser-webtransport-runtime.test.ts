import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const transportModuleUrl = new URL('../public/audio-transport.js', import.meta.url);
const packetizerModuleUrl = new URL('../public/audio-packetizer.js', import.meta.url);

class FakeSocket {
  readyState = 1;
  bufferedAmount = 0;
  sent: unknown[] = [];

  send(payload: unknown) {
    this.sent.push(payload);
  }
}

class DeferredDatagramWriter {
  // Deliberately reports no writable-stream capacity. Relay must use its own
  // bounded outstanding-write accounting instead of treating this as network
  // congestion.
  desiredSize = 0;
  writes: Uint8Array[] = [];
  released = false;
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

  releaseLock() {
    this.released = true;
  }
}

class OverstatedBudgetWebTransport {
  static instances: OverstatedBudgetWebTransport[] = [];
  readonly writer = new DeferredDatagramWriter();
  readonly ready = Promise.resolve();
  readonly datagrams = {
    maxDatagramSize: 65_535,
    outgoingHighWaterMark: 1,
    writable: { getWriter: () => this.writer },
  };
  readonly closed: Promise<void>;
  closeCalls = 0;
  private resolveClosed!: () => void;
  private isClosed = false;

  constructor(readonly url: string, readonly options: Record<string, unknown>) {
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    OverstatedBudgetWebTransport.instances.push(this);
  }

  close() {
    this.closeCalls += 1;
    if (this.isClosed) return;
    this.isClosed = true;
    this.resolveClosed();
  }
}

function framePcm(
  pcm: ArrayBuffer,
  generation: number,
  sequence: number,
  firstSampleIndex: number,
) {
  const headerBytes = 24;
  const packet = new ArrayBuffer(headerBytes + pcm.byteLength);
  const view = new DataView(packet);
  view.setUint16(0, 0x4c52, true);
  view.setUint8(2, 2);
  view.setUint8(3, 1);
  view.setUint32(4, generation >>> 0, true);
  view.setUint32(8, sequence >>> 0, true);
  view.setUint32(12, pcm.byteLength / 2, true);
  view.setFloat64(16, firstSampleIndex, true);
  new Uint8Array(packet, headerBytes).set(new Uint8Array(pcm));
  return packet;
}

function packetIdentity(packet: ArrayBuffer | Uint8Array) {
  const bytes = packet instanceof Uint8Array
    ? packet
    : new Uint8Array(packet);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    generation: view.getUint32(4, true),
    sequence: view.getUint32(8, true),
    sampleCount: view.getUint32(12, true),
    firstSampleIndex: view.getFloat64(16, true),
  };
}

describe('live WebTransport runtime hardening', () => {
  it('clamps Chrome 65535 evidence and packetizes one 20 ms chunk into complete bounded AudioPackets', async () => {
    OverstatedBudgetWebTransport.instances.length = 0;
    const { PreferredAudioTransport } = await import(transportModuleUrl.href);
    const { splitPcmForPacketLimit } = await import(packetizerModuleUrl.href);
    const transport = new PreferredAudioTransport({
      minimumPacketBytes: 26,
      WebTransportClass: OverstatedBudgetWebTransport,
    });
    const socket = new FakeSocket();
    transport.bind(socket);

    assert.equal(await transport.prefer({
      preferred: 'webtransport',
      url: 'https://media.example.test:4433/media?ticket=packetize',
    }), true);

    assert.equal(transport.maxPacketBytes(), 1000);
    const pcm = new ArrayBuffer(1920); // 960 mono Int16 samples = 20 ms at 48 kHz
    const segments = splitPcmForPacketLimit(pcm, transport.maxPacketBytes(), 24);
    assert.deepEqual(
      segments.map((segment: { pcm: ArrayBuffer; sampleOffset: number }) => ({
        sampleOffset: segment.sampleOffset,
        packetBytes: 24 + segment.pcm.byteLength,
      })),
      [
        { sampleOffset: 0, packetBytes: 1000 },
        { sampleOffset: 488, packetBytes: 968 },
      ],
    );

    const results = segments.map((segment: { pcm: ArrayBuffer; sampleOffset: number }, index: number) => (
      transport.send(framePcm(segment.pcm, 9, 100 + index, 48_000 + segment.sampleOffset))
    ));
    assert.deepEqual(results.map((result: { sent: boolean }) => result.sent), [true, true]);

    const instance = OverstatedBudgetWebTransport.instances.at(-1)!;
    assert.deepEqual(instance.writer.writes.map((packet) => packet.byteLength), [1000, 968]);
    assert.deepEqual(instance.writer.writes.map(packetIdentity), [
      { generation: 9, sequence: 100, sampleCount: 488, firstSampleIndex: 48_000 },
      { generation: 9, sequence: 101, sampleCount: 472, firstSampleIndex: 48_488 },
    ]);
    assert.deepEqual(socket.sent, []);

    const stats = transport.stats();
    assert.equal(stats.path, 'webtransport');
    assert.equal(stats.minWebTransportMaxPacketBytes, 65_535);
    assert.equal(stats.maxWebTransportMaxPacketBytes, 65_535);
    assert.equal(stats.datagramPacketBytesCeiling, 1000);
    assert.equal(stats.datagramQueuePackets, 4);
    assert.equal(stats.webTransportPacketsSubmitted, 2);
    assert.equal(stats.webTransportCongestedRejects, 0);
  });

  it('rejects only after the bounded outstanding-write budget is actually full', async () => {
    OverstatedBudgetWebTransport.instances.length = 0;
    const { PreferredAudioTransport } = await import(transportModuleUrl.href);
    const transport = new PreferredAudioTransport({
      minimumPacketBytes: 26,
      datagramQueuePackets: 2,
      WebTransportClass: OverstatedBudgetWebTransport,
    });
    await transport.prefer({
      preferred: 'webtransport',
      url: 'https://media.example.test:4433/media?ticket=bounded',
    });

    assert.equal(transport.send(new Uint8Array(100).buffer).sent, true);
    assert.equal(transport.send(new Uint8Array(100).buffer).sent, true);
    const rejected = transport.send(new Uint8Array(100).buffer);
    assert.equal(rejected.sent, false);
    assert.equal(rejected.reason, 'congested');
    assert.equal(OverstatedBudgetWebTransport.instances.at(-1)!.writer.writes.length, 2);
    assert.equal(transport.stats().webTransportCongestedRejects, 1);
  });

  it('fences an old asynchronous write failure from a replacement WebTransport generation', async () => {
    OverstatedBudgetWebTransport.instances.length = 0;
    const { PreferredAudioTransport } = await import(transportModuleUrl.href);
    const transport = new PreferredAudioTransport({
      minimumPacketBytes: 26,
      datagramQueuePackets: 1,
      WebTransportClass: OverstatedBudgetWebTransport,
    });

    await transport.prefer({
      preferred: 'webtransport',
      url: 'https://media.example.test:4433/media?ticket=old',
    });
    const oldTransport = OverstatedBudgetWebTransport.instances.at(-1)!;
    assert.equal(transport.send(new Uint8Array(100).buffer).sent, true);

    await transport.prefer({
      preferred: 'webtransport',
      url: 'https://media.example.test:4433/media?ticket=new',
    });
    const replacement = OverstatedBudgetWebTransport.instances.at(-1)!;
    assert.notEqual(replacement, oldTransport);
    assert.equal(transport.stats().path, 'webtransport');

    oldTransport.writer.reject(0, 'late old-session failure');
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(transport.stats().path, 'webtransport');
    assert.equal(transport.stats().webTransportSendFailures, 0);
    assert.equal(transport.stats().webTransportDemotions, 0);
    assert.equal(transport.send(new Uint8Array(100).buffer).sent, true,
      'old completion must not decrement or consume the replacement generation budget');
    assert.equal(replacement.writer.writes.length, 1);
  });

  it('closes a demoted session, falls back only for future packets, and preserves packet identity', async () => {
    OverstatedBudgetWebTransport.instances.length = 0;
    const { PreferredAudioTransport } = await import(transportModuleUrl.href);
    const transport = new PreferredAudioTransport({
      minimumPacketBytes: 26,
      WebTransportClass: OverstatedBudgetWebTransport,
    });
    const socket = new FakeSocket();
    transport.bind(socket);
    await transport.prefer({
      preferred: 'webtransport',
      url: 'https://media.example.test:4433/media?ticket=demote',
    });

    const webTransport = OverstatedBudgetWebTransport.instances.at(-1)!;
    const first = framePcm(new ArrayBuffer(4), 17, 40, 1000);
    const second = framePcm(new ArrayBuffer(6), 17, 41, 1002);

    assert.equal(transport.send(first).sent, true);
    transport.demoteWebTransport();
    assert.equal(webTransport.closeCalls, 1);
    assert.equal(transport.stats().path, 'websocket');

    const fallback = transport.send(second);
    assert.equal(fallback.sent, true);
    assert.equal(fallback.path, 'websocket');
    assert.equal(webTransport.writer.writes.length, 1, 'already-submitted datagram is not replayed');
    assert.equal(socket.sent.length, 1);
    assert.equal(socket.sent[0], second);
    assert.deepEqual(packetIdentity(webTransport.writer.writes[0]), {
      generation: 17,
      sequence: 40,
      sampleCount: 2,
      firstSampleIndex: 1000,
    });
    assert.deepEqual(packetIdentity(socket.sent[0] as ArrayBuffer), {
      generation: 17,
      sequence: 41,
      sampleCount: 3,
      firstSampleIndex: 1002,
    });
    assert.equal(transport.stats().webTransportDemotions, 1);
    assert.equal(transport.stats().webSocketPacketsSent, 1);
  });
});
