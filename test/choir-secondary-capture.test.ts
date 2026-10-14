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
    const graph = { returnBuffer: () => { returned++; } };
    let returned = 0;
    c.graph = graph;
    c.context = { currentTime: 1, close: async () => {} };
    c.socket = socket;
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
    const graph = { returnBuffer: () => {} };
    c.graph = graph;
    c.context = { currentTime: 3, close: async () => {} };
    c.socket = socket;
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
