import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Decoder } from '@evan/opus';
import { createOpusEncoder } from '../public/mic-opus-worker.js';
import { createMicOpusTrial } from '../public/mic-opus-trial.js';
import { decodeAudioPacket } from '../src/audio-packet.js';
import { createWebSocketAudioTransport } from '../src/audio-transport.js';

const wasm = readFileSync(new URL('../node_modules/@evan/opus/wasm/opus.wasm', import.meta.url));
function frame(sequence: number, payload: Uint8Array, delay: number, generation = 82001) {
  const packet = Buffer.alloc(28 + payload.length);
  packet.writeUInt16LE(0x4c52, 0); packet[2] = 3; packet[3] = 1;
  packet.writeUInt32LE(generation, 4); packet.writeUInt32LE(sequence, 8);
  packet.writeUInt32LE(960, 12); packet.writeDoubleLE(sequence * 960, 16);
  packet.writeUInt16LE(delay, 24); packet.set(payload, 28);
  return packet;
}
function transport(generation = 82001, allowOpus = true) {
  return createWebSocketAudioTransport({ packetVersion: 2, receiver: {
    source: 'mic', generation, initialSequence: 0, allowOpus,
    reorderWindowPackets: 4, reorderDeadlineMs: 40, maxForwardJumpPackets: 16,
  } });
}

test('real browser WASM Opus survives reorder/duplicate and preserves delayed source coordinates', () => {
  const encoder = createOpusEncoder(wasm, 32000);
  const decoder = new Decoder({ sample_rate: 48000, channels: 1 });
  const receiver = transport();
  const wire: Buffer[] = [], expected: Buffer[] = [];
  for (let sequence = 0; sequence < 6; sequence++) {
    const pcm = new Int16Array(960);
    for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(5000 * Math.sin((sequence * 960 + i) * 2 * Math.PI * 440 / 48000));
    const encoded = encoder.encode(pcm.buffer);
    assert.ok(encoded.length <= 100, '32 kbps must materially reduce a 1920-byte PCM frame');
    const decoded = Buffer.from(decoder.decode(encoded));
    expected.push(sequence === 0 ? decoded.subarray(encoder.delaySamples * 2) : decoded);
    wire.push(frame(sequence, encoded, encoder.delaySamples));
  }
  const output = [0, 2, 2, 1, 3, 5, 4].flatMap((sequence, index) => receiver.receive(wire[sequence], index));
  assert.equal(output.length, 6);
  assert.deepEqual(output.map(p => p.firstSampleIndex), [0, ...[1, 2, 3, 4, 5].map(n => n * 960 - encoder.delaySamples)]);
  assert.deepEqual(Buffer.concat(output.map(p => p.pcm)), Buffer.concat(expected));
  assert.equal(receiver.stats()!.duplicatePackets, 1);
  assert.ok(Buffer.concat(expected).some(value => value !== 0), 'decoded voice cannot be silent');
  const audio = Buffer.concat(output.map(p => p.pcm));
  let dot = 0, sourceEnergy = 0, decodedEnergy = 0;
  for (let i = 480; i < audio.length / 2; i++) {
    const source = 5000 * Math.sin(i * 2 * Math.PI * 440 / 48000);
    const decoded = audio.readInt16LE(i * 2);
    dot += source * decoded; sourceEnergy += source * source; decodedEnergy += decoded * decoded;
  }
  assert.ok(dot / Math.sqrt(sourceEnergy * decodedEnergy) > 0.95,
    'codec delay compensation must align decoded sound with the original samples');
  encoder.reset();
  const fresh = createOpusEncoder(wasm, 32000);
  assert.deepEqual(encoder.encode(new ArrayBuffer(1920)), fresh.encode(new ArrayBuffer(1920)),
    'capture reset must clear codec history');
});

test('wrong-rate receiver and malformed Opus cannot become raw PCM', () => {
  const encoder = createOpusEncoder(wasm);
  const packet = frame(0, encoder.encode(new ArrayBuffer(1920)), encoder.delaySamples, 82002);
  assert.deepEqual(transport(82002, false).receive(packet, 0), []);
  for (const corrupt of [packet.subarray(0, 28), Buffer.from(packet)]) {
    if (corrupt.length > 28) corrupt.writeUInt32LE(0xffffffff, 12);
    assert.equal(decodeAudioPacket(corrupt).ok, false);
  }
  const invalidCodec = frame(0, Uint8Array.of(255), 120, 82003);
  assert.deepEqual(transport(82003).receive(invalidCodec, 0), []);
});

test('compressed WebSocket byte budget remains 200 ms across rebinds', async () => {
  const { WebSocketAudioTransport } = await import(new URL('../public/audio-transport.js', import.meta.url).href);
  const sender = new WebSocketAudioTransport({ maxBufferedBytes: 256 * 1024 });
  sender.setEncodedBitrate(32000);
  sender.bind({ readyState: 1, bufferedAmount: 0, send() {} }, { sampleRate: 48000 });
  assert.equal(sender.maxBufferedBytes, 1080);
  assert.equal(sender.send('x'.repeat(3000), { control: true }).sent, false,
    'control must not overfill the physical voice FIFO');
  assert.equal(sender.send(new Uint8Array(1081)).sent, false, 'media must retain the small budget');
  sender.bind({ readyState: 1, bufferedAmount: 0, send() {} }, { sampleRate: 48000 });
  assert.equal(sender.maxBufferedBytes, 1080);
  sender.setEncodedBitrate(null);
  assert.equal(sender.maxBufferedBytes, 19200);
});

test('browser encoder bounds queued work and fences outputs from a replaced capture', async () => {
  const original = globalThis.Worker;
  let active: FakeWorker;
  class FakeWorker {
    onmessage?: (event: { data: any }) => void;
    messages: any[] = [];
    terminated = false;
    constructor() { active = this; }
    postMessage(data: any) {
      this.messages.push(data);
      if (data.type === 'init') queueMicrotask(() => this.onmessage?.({ data: { type: 'ready', delaySamples: 120 } }));
    }
    terminate() { this.terminated = true; }
    complete(id: number) { this.onmessage?.({ data: { type: 'encoded', id, encoded: new ArrayBuffer(80) } }); }
  }
  Object.assign(globalThis, { Worker: FakeWorker });
  try {
    const packets: ArrayBuffer[] = [], drops: number[] = [];
    const encoder = await createMicOpusTrial({ onPacket: p => packets.push(p), onDrop: n => drops.push(n) });
    assert.equal(encoder.bitrate, 32000);
    encoder.setBitrate(128000);
    assert.equal(encoder.bitrate, 32000, 'report only worker-confirmed bitrate');
    active!.onmessage?.({ data: { type: 'bitrate', bitrate: 128000 } });
    assert.equal(encoder.bitrate, 128000);
    encoder.reset(10);
    assert.equal(encoder.encode(new ArrayBuffer(1920), 0, 0), true);
    assert.equal(encoder.encode(new ArrayBuffer(1920), 1, 960), true);
    assert.equal(encoder.encode(new ArrayBuffer(1920), 2, 1920), false);
    assert.deepEqual(drops, [960]);
    encoder.reset(11);
    active!.complete(0); active!.complete(1);
    assert.equal(packets.length, 0);
    encoder.encode(new ArrayBuffer(1920), 0, 0);
    active!.complete(2);
    const parsed = decodeAudioPacket(Buffer.from(packets[0]));
    assert.ok(parsed.ok);
    if (parsed.ok) { assert.equal(parsed.packet.generation, 11); assert.equal(parsed.packet.opusDelaySamples, 120); }
    encoder.close();
    assert.equal(active!.terminated, true);
  } finally {
    Object.assign(globalThis, { Worker: original });
  }
});

for (const failure of ['message', 'worker', 'postMessage', 'timeout']) {
  test(`Opus startup ${failure} failure terminates its inaccessible worker once`, async (t) => {
    const original = globalThis.Worker;
    let active: any;
    let errors = 0;
    if (failure === 'timeout') t.mock.timers.enable({ apis: ['setTimeout'] });
    class FailingWorker {
      onmessage?: (event: { data: any }) => void;
      onerror?: () => void;
      terminations = 0;
      constructor() { active = this; }
      postMessage() {
        if (failure === 'postMessage') throw new Error('init refused');
        if (failure === 'timeout') return;
        queueMicrotask(() => {
          if (failure === 'message') this.onmessage?.({ data: { type: 'error', message: 'init failed' } });
          else this.onerror?.();
        });
      }
      terminate() { this.terminations++; }
    }
    Object.assign(globalThis, { Worker: FailingWorker });
    try {
      const starting = createMicOpusTrial({ onPacket() { assert.fail('late output'); },
        onDrop() {}, onError() { errors++; } });
      const rejected = assert.rejects(starting, /failed|refused|timed out/);
      if (failure === 'timeout') t.mock.timers.tick(8000);
      await rejected;
      active.onerror?.();
      active.onmessage?.({ data: { type: 'error', message: 'duplicate' } });
      active.onmessage?.({ data: { type: 'ready', delaySamples: 120 } });
      assert.equal(active.terminations, 1);
      assert.equal(errors, 1);
    } finally { Object.assign(globalThis, { Worker: original }); }
  });
}
