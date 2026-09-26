import assert from 'node:assert/strict';
import test from 'node:test';

import WebSocket, { type WebSocketServer } from 'ws';
import { Decoder } from '@evan/opus';

import {
  MONITOR_CODEC_FRAME_HEADER_BYTES,
  encodeMonitorOpusFrame,
  loadMonitorOpusEncoder,
  type MonitorOpusEncoder,
} from '../src/monitor-opus.js';
import { createMonitorSocketTransport, type RelaySocket } from '../src/relay-socket-server.js';
import { createMonitorPcmReceiver, decodeMonitorPcmFrame } from '../public/monitor-pcm-continuity.js';

const FRAME = 960;

function fakeSocket(options: { monitorCodec?: 'opus'; bufferedAmount?: number } = {}) {
  const sent: Buffer[] = [];
  const socket = {
    role: 'monitor',
    readyState: WebSocket.OPEN,
    monitorPacketVersion: 1,
    monitorCodec: options.monitorCodec,
    bufferedAmount: options.bufferedAmount ?? 0,
    send(payload: Buffer) {
      sent.push(payload);
    },
  } as unknown as RelaySocket;
  return { socket, sent };
}

function fakeServer(...sockets: RelaySocket[]) {
  return { clients: new Set(sockets) } as unknown as WebSocketServer;
}

function fakeEncoder() {
  const calls: string[] = [];
  const encoder: MonitorOpusEncoder & { fail?: boolean } = {
    encode(pcm) {
      if (encoder.fail) throw new Error('encoder broke');
      calls.push(`encode:${pcm.byteLength}`);
      return Uint8Array.of(1, 2, 3);
    },
    reset() {
      calls.push('reset');
    },
  };
  return { encoder, calls };
}

function tone(firstSampleIndex: number) {
  const pcm = Buffer.alloc(FRAME * 2);
  for (let i = 0; i < FRAME; i += 1) {
    pcm.writeInt16LE(Math.round(12_000 * Math.sin((2 * Math.PI * 440 * (firstSampleIndex + i)) / 48_000)), i * 2);
  }
  return pcm;
}

function asArrayBuffer(buffer: Buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

test('an Opus codec frame carries the mix position, sample count and packet', () => {
  const frame = encodeMonitorOpusFrame(7, 12_480, FRAME, Uint8Array.of(9, 8, 7));
  assert.equal(frame.byteLength, MONITOR_CODEC_FRAME_HEADER_BYTES + 3);
  const decoded = decodeMonitorPcmFrame(asArrayBuffer(frame));
  assert.ok(decoded && decoded.codec === 'opus');
  assert.equal(decoded.generation, 7);
  assert.equal(decoded.firstSampleIndex, 12_480);
  assert.equal(decoded.sampleCount, FRAME);
  assert.deepEqual([...new Uint8Array(decoded.packet)], [9, 8, 7]);
});

test('Listen continuity treats Opus frames exactly like PCM frames', () => {
  const receiver = createMonitorPcmReceiver();
  const at = (index: number) => asArrayBuffer(encodeMonitorOpusFrame(3, index, FRAME, Uint8Array.of(1)));
  assert.equal(receiver.receive(at(0)).reason, 'first');
  assert.equal(receiver.receive(at(FRAME)).reason, 'contiguous');
  const gap = receiver.receive(at(FRAME * 3));
  assert.deepEqual([gap.action, gap.reason, gap.action === 'accept' && gap.gapSamples], ['accept', 'gap', FRAME]);
  assert.equal(receiver.receive(at(FRAME)).reason, 'stale');
});

test('a malformed codec frame is dropped, never played as PCM', () => {
  const frame = encodeMonitorOpusFrame(1, 0, FRAME, Uint8Array.of(1));
  const unknownCodec = Buffer.from(frame);
  unknownCodec.writeUInt8(9, 3);
  assert.equal(decodeMonitorPcmFrame(asArrayBuffer(unknownCodec)), null);
  const noSamples = Buffer.from(frame);
  noSamples.writeUInt32LE(0, 16);
  assert.equal(decodeMonitorPcmFrame(asArrayBuffer(noSamples)), null);
});

test('Opus listeners get one shared encoding per frame; PCM listeners keep PCM', () => {
  const opusA = fakeSocket({ monitorCodec: 'opus' });
  const opusB = fakeSocket({ monitorCodec: 'opus' });
  const pcm = fakeSocket();
  const { encoder, calls } = fakeEncoder();
  const transport = createMonitorSocketTransport(fakeServer(opusA.socket, opusB.socket, pcm.socket), {
    backlogBytes: 100_000,
    opusBacklogBytes: 100_000,
  });
  transport.enableOpus(encoder);

  transport.broadcast(tone(0), true, { generation: 1, firstSampleIndex: 0 });
  transport.broadcast(tone(FRAME), true, { generation: 1, firstSampleIndex: FRAME });

  assert.deepEqual(calls, ['reset', `encode:${FRAME * 2}`, `encode:${FRAME * 2}`],
    'encoded once per frame for every Opus listener, and only reset where the stream begins');
  assert.equal(opusA.sent[0], opusB.sent[0], 'both Opus listeners get the same bytes');
  assert.equal(opusA.sent[0].readUInt8(2), 2);
  assert.equal(pcm.sent[0].readUInt8(2), 1);
  assert.equal(pcm.sent[0].byteLength, 16 + FRAME * 2);
});

test('the encoder restarts where the Opus stream does not continue, and idles without Opus listeners', () => {
  const opus = fakeSocket({ monitorCodec: 'opus' });
  const pcm = fakeSocket();
  const { encoder, calls } = fakeEncoder();
  const clients = new Set<RelaySocket>([pcm.socket]);
  const transport = createMonitorSocketTransport({ clients } as unknown as WebSocketServer, {
    backlogBytes: 100_000,
  });
  transport.enableOpus(encoder);

  transport.broadcast(tone(0), true, { generation: 1, firstSampleIndex: 0 });
  assert.deepEqual(calls, [], 'nothing is encoded while nobody listens on Opus');

  clients.add(opus.socket);
  transport.broadcast(tone(FRAME), true, { generation: 1, firstSampleIndex: FRAME });
  transport.broadcast(tone(FRAME * 2), true, { generation: 1, firstSampleIndex: FRAME * 2 });
  transport.broadcast(tone(0), true, { generation: 2, firstSampleIndex: 0 });
  assert.deepEqual(calls, [
    'reset', `encode:${FRAME * 2}`,
    `encode:${FRAME * 2}`,
    'reset', `encode:${FRAME * 2}`,
  ]);
});

test('Opus monitors use the same downstream ACK limit and live-edge recovery as PCM', () => {
  let nowMs = 0;
  const opus = fakeSocket({ monitorCodec: 'opus' });
  const { encoder } = fakeEncoder();
  const transport = createMonitorSocketTransport(fakeServer(opus.socket), {
    backlogBytes: 100_000,
    opusBacklogBytes: 100_000,
    unacknowledgedSamples: FRAME * 5,
    nowMs: () => nowMs,
  });
  transport.enableOpus(encoder);
  const publish = (index: number) => {
    nowMs = index * 20;
    transport.broadcast(tone(index * FRAME), true, { generation: 1, firstSampleIndex: index * FRAME });
  };
  const positions = () => opus.sent.map((wire) => {
    const frame = decodeMonitorPcmFrame(asArrayBuffer(wire));
    assert.ok(frame && frame.codec === 'opus');
    return frame.firstSampleIndex / FRAME;
  });
  publish(0);
  assert.equal(transport.acknowledge(opus.socket, {
    type: 'monitor-ack', generation: 1, receivedEndSampleIndex: FRAME,
  }), true);
  assert.deepEqual(opus.socket.monitorDelivery?.sent, { generation: 1, endSampleIndex: FRAME },
    'Opus ACK counts the original 960 mix samples, not compressed packet bytes');
  for (let index = 1; index <= 10; index += 1) publish(index);
  assert.deepEqual(positions(), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(transport.recentDrops().frames, 4);
  transport.acknowledge(opus.socket, {
    type: 'monitor-ack', generation: 1, receivedEndSampleIndex: FRAME * 7,
  });
  publish(11);
  assert.deepEqual(positions(), [0, 1, 2, 3, 4, 5, 6, 11],
    'a downstream-stalled Opus listener catches up instead of replaying stale frames');
});

test('an encoder failure keeps Opus listeners playing, on PCM', () => {
  const opus = fakeSocket({ monitorCodec: 'opus' });
  const { encoder } = fakeEncoder();
  const transport = createMonitorSocketTransport(fakeServer(opus.socket), { backlogBytes: 100_000 });
  transport.enableOpus(encoder);
  encoder.fail = true;
  const warn = console.warn;
  console.warn = () => {};
  try {
    transport.broadcast(tone(0), true, { generation: 1, firstSampleIndex: 0 });
    transport.broadcast(tone(FRAME), true, { generation: 1, firstSampleIndex: FRAME });
  } finally {
    console.warn = warn;
  }
  assert.equal(transport.opusEnabled, false);
  assert.deepEqual(opus.sent.map((frame) => frame.readUInt8(2)), [1, 1]);
});

test('an Opus listener gets the same backlog time budget at the Opus bitrate', () => {
  // The same 2,390 queued bytes are ~200 ms of Opus but ~25 ms of PCM.
  const opus = fakeSocket({ monitorCodec: 'opus', bufferedAmount: 2_390 });
  const pcm = fakeSocket({ bufferedAmount: 2_390 });
  const { encoder } = fakeEncoder();
  const transport = createMonitorSocketTransport(fakeServer(opus.socket, pcm.socket), {
    backlogBytes: 19_200,
    opusBacklogBytes: 2_400,
  });
  transport.enableOpus(encoder);
  transport.broadcast(tone(0), true, { generation: 1, firstSampleIndex: 0 });
  assert.equal(opus.sent.length, 0, 'the Opus listener is already a full time budget behind');
  assert.equal(pcm.sent.length, 1);
  assert.equal(transport.droppedFrames, 1);
});

test('the room mix survives the real Opus encoder and decoder', async () => {
  const encoder = await loadMonitorOpusEncoder({ sampleRate: 48_000, bitrate: 96_000 });
  const decoder = new Decoder({ channels: 1, sample_rate: 48_000 });
  let peak = 0;
  let bytes = 0;
  for (let index = 0; index < 50; index += 1) {
    const packet = encoder.encode(tone(index * FRAME));
    bytes += packet.byteLength;
    const decoded = decoder.decode(packet);
    assert.equal(decoded.byteLength, FRAME * 2);
    if (index > 5) {
      const samples = new Int16Array(decoded.buffer, decoded.byteOffset, FRAME);
      for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
    }
  }
  assert.ok(Math.abs(peak - 12_000) < 1_200, `decoded peak ${peak}`);
  assert.ok(bytes / 50 < 400, `average packet ${bytes / 50} bytes, PCM is ${FRAME * 2}`);
  await assert.rejects(loadMonitorOpusEncoder({ sampleRate: 44_100, bitrate: 96_000 }), /48 kHz/);
});
