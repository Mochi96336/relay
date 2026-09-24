import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { encodeAudioPacket } from '../src/audio-packet.js';

const moduleUrl = new URL('../public/audio-transport.js', import.meta.url);

class FakeSocket {
  readyState = 1;
  bufferedAmount = 0;
  sent: unknown[] = [];
  private listeners: ((event: { data: unknown }) => void)[] = [];

  send(payload: unknown) {
    this.sent.push(payload);
  }

  addEventListener(type: string, listener: (event: { data: unknown }) => void) {
    if (type === 'message') this.listeners.push(listener);
  }

  removeEventListener(type: string, listener: (event: { data: unknown }) => void) {
    if (type === 'message') this.listeners = this.listeners.filter((entry) => entry !== listener);
  }

  deliver(message: unknown) {
    for (const listener of this.listeners) listener({ data: JSON.stringify(message) });
  }
}

class FakeDatagramWriter {
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
  readonly closed = new Promise<void>(() => {});
  readonly datagrams = {
    maxDatagramSize: 1200,
    writable: { getWriter: () => this.writer },
  };
  constructor(readonly url: string, readonly options: Record<string, unknown>) {
    FakeWebTransport.instances.push(this);
  }
  close() {}
}

function mediaPacket(generation: number, sequence: number) {
  const packet = encodeAudioPacket({
    source: 'mic',
    generation,
    sequence,
    firstSampleIndex: sequence * 480,
    pcm: Buffer.alloc(960, sequence & 0xff),
  });
  return new Uint8Array(packet.buffer, packet.byteOffset, packet.byteLength).slice().buffer;
}

function sequenceOf(bytes: Uint8Array) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8, true);
}

async function webTransportPath() {
  const { PreferredAudioTransport } = await import(moduleUrl.href);
  FakeWebTransport.instances.length = 0;
  const transport = new PreferredAudioTransport({
    minimumPacketBytes: 26,
    WebTransportClass: FakeWebTransport,
  });
  const socket = new FakeSocket();
  transport.bind(socket);
  await transport.prefer({
    preferred: 'webtransport',
    url: 'https://media.example.test:4433/media?ticket=retransmit',
  });
  return { transport, socket, webTransport: FakeWebTransport.instances.at(-1)! };
}

const settle = async () => {
  for (let tick = 0; tick < 4; tick += 1) await Promise.resolve();
};

describe('browser Mic retransmission', () => {
  it('advertises its retransmission buffer to Relay through transport stats', async () => {
    const { transport } = await webTransportPath();
    assert.equal(transport.stats().retransmitBufferPackets, 128);
    assert.equal(transport.stats().retransmittedPackets, 0);
  });

  it('repeats a requested packet byte for byte on the active datagram path', async () => {
    const { transport, socket, webTransport } = await webTransportPath();
    for (let sequence = 0; sequence < 3; sequence += 1) {
      assert.equal(transport.send(mediaPacket(7, sequence)).sent, true);
    }
    await settle();

    socket.deliver({ type: 'audio-retransmit-request', version: 1, captureGeneration: 7, sequences: [1] });
    await settle();

    assert.deepEqual(webTransport.writer.writes.map(sequenceOf), [0, 1, 2, 1]);
    assert.deepEqual(webTransport.writer.writes[3], webTransport.writer.writes[1]);
    const stats = transport.stats();
    assert.equal(stats.retransmittedPackets, 1);
    assert.equal(stats.webTransportPacketsSubmitted, 3, 'a repeat is not a new capture packet');
    assert.deepEqual(socket.sent, [], 'and it is not duplicated onto the control socket');
  });

  it('answers each sequence once and ignores other captures or forgotten packets', async () => {
    const { transport, socket, webTransport } = await webTransportPath();
    transport.send(mediaPacket(7, 0));
    transport.send(mediaPacket(7, 1));
    await settle();

    socket.deliver({ type: 'audio-retransmit-request', version: 1, captureGeneration: 7, sequences: [1, 1] });
    socket.deliver({ type: 'audio-retransmit-request', version: 1, captureGeneration: 7, sequences: [1] });
    socket.deliver({ type: 'audio-retransmit-request', version: 1, captureGeneration: 8, sequences: [0] });
    socket.deliver({ type: 'audio-retransmit-request', version: 1, captureGeneration: 7, sequences: [99] });
    await settle();

    assert.deepEqual(webTransport.writer.writes.map(sequenceOf), [0, 1, 1]);
    assert.equal(transport.stats().retransmittedPackets, 1);
  });

  it('repeats over the WebSocket media path when no datagram path is active', async () => {
    const { PreferredAudioTransport } = await import(moduleUrl.href);
    const transport = new PreferredAudioTransport();
    const socket = new FakeSocket();
    transport.bind(socket);
    transport.send(mediaPacket(3, 5));
    socket.deliver({ type: 'audio-retransmit-request', version: 1, captureGeneration: 3, sequences: [5] });

    assert.equal(socket.sent.length, 2);
    assert.equal(sequenceOf(new Uint8Array(socket.sent[1] as Uint8Array)), 5);
    assert.equal(transport.stats().webSocketPacketsSent, 1, 'the repeat does not inflate coverage');
    assert.equal(transport.stats().retransmittedPackets, 1);
  });

  it('answers a request that arrives on the direct session datagrams', async () => {
    const { encodeRetransmitRequest } = await import('../shared/retransmit-request.js');
    const { PreferredAudioTransport } = await import(moduleUrl.href);
    const inbound: Uint8Array[] = [];
    let wake: (() => void) | null = null;
    class InboundWebTransport extends FakeWebTransport {
      readonly datagrams = {
        maxDatagramSize: 1200,
        writable: { getWriter: () => this.writer },
        readable: {
          getReader: () => ({
            read: async () => {
              while (inbound.length === 0) await new Promise<void>((resolve) => { wake = resolve; });
              return { done: false, value: inbound.shift()! };
            },
            releaseLock() {},
          }),
        },
      };
    }
    FakeWebTransport.instances.length = 0;
    const transport = new PreferredAudioTransport({
      minimumPacketBytes: 26,
      WebTransportClass: InboundWebTransport,
    });
    const socket = new FakeSocket();
    transport.bind(socket);
    await transport.prefer({ preferred: 'webtransport', url: 'https://media.example.test:4433/media?ticket=in' });
    const webTransport = FakeWebTransport.instances.at(-1)!;
    transport.send(mediaPacket(7, 0));
    transport.send(mediaPacket(7, 1));
    await settle();

    // Unrelated datagrams on the path are ignored; the request is answered.
    inbound.push(new Uint8Array([1, 2, 3]), encodeRetransmitRequest(7, [0]));
    (wake as (() => void) | null)?.();
    await settle();
    await settle();

    assert.deepEqual(webTransport.writer.writes.map(sequenceOf), [0, 1, 0]);
    assert.equal(transport.stats().retransmitDatagramRequests, 1);

    // The same request arriving later over the control socket is not repeated twice.
    socket.deliver({ type: 'audio-retransmit-request', version: 1, captureGeneration: 7, sequences: [0] });
    await settle();
    assert.equal(webTransport.writer.writes.length, 3);
  });

  it('keeps only a bounded history and forgets it with the capture', async () => {
    const { PreferredAudioTransport } = await import(moduleUrl.href);
    const transport = new PreferredAudioTransport({ retransmitBufferPackets: 2 });
    const socket = new FakeSocket();
    transport.bind(socket);
    for (let sequence = 0; sequence < 3; sequence += 1) transport.send(mediaPacket(4, sequence));
    socket.deliver({ type: 'audio-retransmit-request', version: 1, captureGeneration: 4, sequences: [0, 2] });
    assert.deepEqual(socket.sent.slice(3).map((sent) => sequenceOf(new Uint8Array(sent as Uint8Array))), [2]);

    transport.close();
    transport.bind(socket);
    socket.deliver({ type: 'audio-retransmit-request', version: 1, captureGeneration: 4, sequences: [1] });
    assert.equal(socket.sent.length, 4, 'a closed capture answers nothing');
  });
});
