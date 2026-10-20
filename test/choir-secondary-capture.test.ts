import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeAudioPacket } from '../src/audio-packet.js';
import {
  ChoirSecondaryCapture, encodeChoirMicV2,
} from '../public/choir-secondary-capture.js';

test('mobile B AudioPacket v2 matches server canonical framing at native 44.1k/48k rates', () => {
  for (const count of [882, 960, 1920]) {
    const native = new Int16Array(count);
    native[0] = -32_000;
    native[1] = 17_000;
    native[native.length - 1] = 12_000;
    const packet = encodeChoirMicV2(native.buffer, 7, 42, 13_765);
    const decoded = decodeAudioPacket(Buffer.from(packet));
    assert.equal(decoded.ok, true);
    if (!decoded.ok) continue;
    assert.deepEqual({
      source: decoded.packet.source,
      generation: decoded.packet.generation,
      sequence: decoded.packet.sequence,
      firstSampleIndex: decoded.packet.firstSampleIndex,
      sampleCount: decoded.packet.sampleCount,
    }, {
      source: 'mic', generation: 7, sequence: 42,
      firstSampleIndex: 13_765, sampleCount: count,
    });
    assert.deepEqual([...new Int16Array(
      decoded.packet.pcm.buffer,
      decoded.packet.pcm.byteOffset,
      decoded.packet.pcm.byteLength / 2,
    )], [...native]);
  }
});

test('v2 encoder rejects malformed source PCM, cursor overflow and invalid generation', () => {
  assert.throws(() => encodeChoirMicV2(new ArrayBuffer(0), 1, 0, 0), RangeError);
  assert.throws(() => encodeChoirMicV2(new ArrayBuffer(3), 1, 0, 0), RangeError);
  assert.throws(() => encodeChoirMicV2(new ArrayBuffer(4), -1, 0, 0), RangeError);
  assert.throws(() => encodeChoirMicV2(new ArrayBuffer(4), 1, 0, -1), RangeError);
  assert.throws(() => encodeChoirMicV2(new ArrayBuffer(4), 1, 0,
    Number.MAX_SAFE_INTEGER), RangeError);
});

for (const bitrate of [null, 32_000, 64_000, 128_000]) {
  test(`B bounds ${bitrate ?? 'PCM'} backlog by time, including the next packet, across rebinds`, () => {
    const c = new ChoirSecondaryCapture();
    const sent: ArrayBuffer[] = [];
    const socket = { readyState: 1, bufferedAmount: 0, send: (p: ArrayBuffer) => sent.push(p) };
    c.socket = socket;
    c.transport.setEncodedBitrate(bitrate);
    c.transport.bind(socket, { sampleRate: 48_000 });
    const packet = new ArrayBuffer(bitrate === null ? 1944 : bitrate / 8 / 50 + 28);
    const budget = c.transport.maxBufferedBytes;
    socket.bufferedAmount = budget - packet.byteLength;
    assert.equal(c.sendPacket(packet), true, 'one frame may exactly fill the budget');
    socket.bufferedAmount++;
    assert.equal(c.sendPacket(packet), false, 'incoming bytes count before enqueueing');
    const replacement = { ...socket, bufferedAmount: 0 };
    c.socket = replacement;
    c.transport.bind(replacement, { sampleRate: 48_000 });
    assert.equal(c.transport.maxBufferedBytes, budget);
    assert.equal(c.sendPacket(packet), true);
    assert.equal(sent.length, 2);
    c.stop();
    assert.equal(c.sendPacket(packet), false);
  });
}

test('secondary capture advances native cursor through WebSocket backlog without replaying old samples', () => {
  const previous = globalThis.WebSocket;
  Object.assign(globalThis, { WebSocket: { OPEN: 1 } });
  try {
    const c = new ChoirSecondaryCapture();
    const sent: ArrayBuffer[] = [];
    const socket = {
      readyState: 1, bufferedAmount: 0,
      send: (packet: ArrayBuffer) => sent.push(packet),
    };
    const graph = { returnBuffer: () => { returned++; }, dispose: () => {} };
    let returned = 0;
    c.graph = graph;
    c.context = { currentTime: 1, close: async () => {} };
    c.socket = socket;
    c.transport.bind(socket, { sampleRate: 48_000 });
    c.rate = 48_000;
    c.generation = 55;
    const epoch = c.epoch;
    const pcm = new Int16Array(960).fill(2_500).buffer;
    c.onCapture({ data: { type: 'pcm', buffer: pcm, capturedAtContextTime: 0.98 } }, graph, epoch);
    socket.bufferedAmount = 300_000;
    c.onCapture({ data: { type: 'pcm', buffer: pcm, capturedAtContextTime: 0.98 } }, graph, epoch);
    socket.bufferedAmount = 0;
    c.onCapture({ data: { type: 'pcm', buffer: pcm, capturedAtContextTime: 0.98 } }, graph, epoch);
    assert.equal(c.cursor, 2_880);
    assert.equal(returned, 3);
    assert.equal(sent.length, 2);
    const packets = sent.map(buf => decodeAudioPacket(Buffer.from(buf)));
    assert.equal(packets.every(p => p.ok), true);
    assert.deepEqual(packets.map(p => p.ok && p.packet.firstSampleIndex), [0, 1920]);
    assert.deepEqual(packets.map(p => p.ok && p.packet.sequence), [0, 1]);
    c.stop();
  } finally {
    Object.assign(globalThis, { WebSocket: previous });
  }
});

test('stale PCM never enters a newer capture generation and input-gap fails closed', () => {
  const previous = globalThis.WebSocket;
  Object.assign(globalThis, { WebSocket: { OPEN: 1 } });
  try {
    const stopped: string[] = [];
    const c = new ChoirSecondaryCapture(reason => stopped.push(reason));
    const sent: ArrayBuffer[] = [];
    const socket = { readyState: 1, bufferedAmount: 0,
      send: (p: ArrayBuffer) => sent.push(p) };
    const graph = { returnBuffer: () => {}, dispose: () => {} };
    c.graph = graph;
    c.context = { currentTime: 3, close: async () => {} };
    c.socket = socket;
    c.transport.bind(socket, { sampleRate: 44_100 });
    c.rate = 44_100;
    c.generation = 9;
    const epoch = c.epoch;
    c.onCapture({ data: { type: 'pcm',
      buffer: new Int16Array(882).buffer,
      capturedAtContextTime: 2.1 } }, graph, epoch);
    assert.equal(sent.length, 0, 'nearly one second old audio must be dropped');
    assert.equal(c.cursor, 882);
    c.onCapture({ data: { type: 'input-gap', quanta: 2, samples: 256 } }, graph, epoch);
    assert.deepEqual(stopped, ['input-gap']);
    assert.equal(c.context, null);
    c.onCapture({ data: { type: 'pcm', buffer: new Int16Array(882).buffer,
      capturedAtContextTime: 2.98 } }, graph, epoch);
    assert.equal(sent.length, 0, 'late Worklet callback cannot revive a stopped capture');
  } finally {
    Object.assign(globalThis, { WebSocket: previous });
  }
});

test('a newly claimed B socket starts matching codec history without replacing the capture clock', () => {
  const previous = globalThis.WebSocket;
  Object.assign(globalThis, { WebSocket: { OPEN: 1 } });
  try {
    const c = new ChoirSecondaryCapture();
    const resets: number[] = [];
    c.opus = { reset: (generation: number) => resets.push(generation), close() {} };
    c.graph = {};
    c.context = { state: 'running' };
    (c as any).track = { readyState: 'live', muted: false };
    c.rate = 48_000; c.generation = 7; c.cursor = 19_440; c.sequence = 20;
    const first = { readyState: 1 }, second = { readyState: 1 };
    assert.equal(c.attach(first, 48_000), true);
    assert.equal(c.attach(first, 48_000), true, 'the same binding does not restart prediction');
    assert.equal(c.attach(second, 48_000), true);
    assert.deepEqual(resets, [7, 7]);
    assert.deepEqual([c.generation, c.cursor, c.sequence], [7, 19_440, 20]);
  } finally { Object.assign(globalThis, { WebSocket: previous }); }
});

test('a HyperX-style 66% AudioContext capture clock cannot pass as valid secondary PCM', () => {
  const previous = globalThis.WebSocket;
  Object.assign(globalThis, { WebSocket: { OPEN: 1 } });
  try {
    const failures: string[] = [];
    const c = new ChoirSecondaryCapture(reason => failures.push(reason));
    const sent: ArrayBuffer[] = [];
    let returned = 0;
    const graph = { returnBuffer: () => { returned++; }, dispose: () => {} };
    c.graph = graph;
    c.context = { currentTime: 6, close: async () => {} };
    c.socket = { readyState: 1, bufferedAmount: 0,
      send: (packet: ArrayBuffer) => sent.push(packet) };
    c.rate = 48_000;
    c.generation = 10;
    // The actual wall clock has advanced 6s, but the AudioContext would
    // produce only 4s of native samples (66.7%). This MUST be detected
    // before the next packet gets promoted as a fresh Content sample.
    c.clockWallOriginMs = performance.now() - 6_000;
    c.clockSampleOrigin = 0;
    c.cursor = 4 * 48_000;
    const epoch = c.epoch;
    c.onCapture({ data: { type: 'pcm', buffer: new Int16Array(960).buffer,
      capturedAtContextTime: 5.98 } }, graph, epoch);
    assert.deepEqual(failures, ['capture-clock-diverged']);
    assert.equal(returned, 1,
      'clock rejection must execute the Worklet buffer finally before exit');
    assert.equal(sent.length, 0);
    assert.equal(c.context, null);
    assert.equal(c.rate, null);
    c.onCapture({ data: { type: 'pcm', buffer: new Int16Array(960).buffer,
      capturedAtContextTime: 5.98 } }, graph, epoch);
    assert.equal(sent.length, 0);
  } finally {
    Object.assign(globalThis, { WebSocket: previous });
  }
});
