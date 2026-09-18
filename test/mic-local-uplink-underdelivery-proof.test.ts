import assert from 'node:assert/strict';
import test from 'node:test';

const moduleUrl = new URL('../public/audio-transport.js', import.meta.url);
const GENERATION = 7;
const PACKET_SAMPLES = 480;
const ATTEMPTS_PER_WINDOW = 99;

class BrowserSocket {
  readyState = 1;
  bufferedAmount = 0;
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  private readonly listeners = new Map<string, Set<(event: { data: string }) => void>>();

  send(_payload: unknown) {}

  close(code?: number, reason?: string) {
    this.closeCalls.push({ code, reason });
    this.readyState = 2;
  }

  addEventListener(type: string, listener: (event: { data: string }) => void) {
    const current = this.listeners.get(type) ?? new Set();
    current.add(listener);
    this.listeners.set(type, current);
  }

  removeEventListener(type: string, listener: (event: { data: string }) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(message: unknown) {
    const event = { data: JSON.stringify(message) };
    for (const listener of this.listeners.get('message') ?? []) listener(event);
  }
}

class SlowWriter {
  readonly pending: Array<() => void> = [];
  released = false;

  write(_payload: Uint8Array) {
    return new Promise<void>((resolve) => {
      this.pending.push(resolve);
    });
  }

  settleOne() {
    this.pending.shift()?.();
  }

  releaseLock() {
    this.released = true;
  }
}

class SlowWebTransport {
  static instances: SlowWebTransport[] = [];

  readonly ready = Promise.resolve();
  readonly writer = new SlowWriter();
  readonly datagrams = {
    maxDatagramSize: 1_200,
    writable: { getWriter: () => this.writer },
    outgoingHighWaterMark: 1,
  };
  readonly closed = new Promise<void>(() => {});
  closeCalls = 0;

  constructor(_url: string, _options?: unknown) {
    SlowWebTransport.instances.push(this);
  }

  close() {
    this.closeCalls += 1;
  }
}

async function settleWriter(writer: SlowWriter) {
  writer.settleOne();
  await Promise.resolve();
  await Promise.resolve();
}

test('severe local WT congestion counts as packet under-delivery and demotes the path', async () => {
  SlowWebTransport.instances.length = 0;
  const { PreferredAudioTransport } = await import(moduleUrl.href);
  const socket = new BrowserSocket();
  const transport = new PreferredAudioTransport({
    WebTransportClass: SlowWebTransport,
    datagramQueuePackets: 1,
  });
  transport.bind(socket);
  assert.equal(await transport.prefer({
    preferred: 'webtransport',
    url: 'https://relay.test/local-underdelivery',
  }), true);

  let capturedSamples = 0;
  let localDroppedSamples = 0;
  let submittedPackets = 0;

  for (let window = 0; window < 4; window += 1) {
    const writer = SlowWebTransport.instances[0].writer;
    for (let attempt = 0; attempt < ATTEMPTS_PER_WINDOW; attempt += 1) {
      capturedSamples += PACKET_SAMPLES;
      const result = transport.send(new Uint8Array(100));
      if (result.sent) {
        submittedPackets += 1;
      } else {
        assert.equal(result.reason, 'congested');
        localDroppedSamples += PACKET_SAMPLES;
      }

      // One accepted write stays pending while the next two capture packets are
      // rejected by the bounded realtime queue. Then the write resolves before
      // the next trio, so the 1 s write-stall watchdog never owns this failure.
      if (attempt % 3 === 2) await settleWriter(writer);
    }

    const health = {
      type: 'audio-uplink-health',
      version: 1,
      captureGeneration: GENERATION,
      capturedSamples,
      droppedSamples: {
        total: localDroppedSamples,
        disconnected: 0,
        congested: localDroppedSamples,
        packetTooLarge: 0,
      },
      transport: { path: 'webtransport' },
    };
    assert.equal(transport.sendControlJson(health).sent, true);

    // Relay receives every admitted packet, but the browser's final-attempt
    // denominator also includes the two congestion rejects in each trio.
    socket.emit({
      type: 'audio-uplink-health-ack',
      version: 1,
      captureGeneration: GENERATION,
      pcm: {
        acceptedFrameSerial: submittedPackets,
        receivedPacketSerial: submittedPackets,
        mediaPath: 'webtransport',
      },
    });
  }

  const stats = transport.stats();
  assert.equal(stats.webTransportPacketsSubmitted, 132);
  assert.equal(stats.webTransportCongestedRejects, 264);
  assert.equal(localDroppedSamples, PACKET_SAMPLES * 264);
  assert.equal((transport as any).lastMediaRecoveryDecision?.reason, 'server-pcm-underdelivery');
  assert.ok(Math.abs((transport as any).lastMediaRecoveryDecision?.packetCoverage - (1 / 3)) < 1e-9);
  assert.equal(transport.stats().path, 'websocket');
  assert.equal(stats.webTransportDemotions, 1);
  assert.equal(socket.closeCalls.length, 0);

  transport.close();
});
