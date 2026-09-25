import assert from 'node:assert/strict';
import test from 'node:test';

import WebSocket, { type WebSocketServer } from 'ws';

import { decodePcmFrame } from '../src/pcm-frame.js';
import { createMonitorSocketTransport, type RelaySocket } from '../src/relay-socket-server.js';

type Sent = { payload: unknown; options: unknown };

function fakeSocket(options: {
  role?: RelaySocket['role'];
  readyState?: number;
  monitorPacketVersion?: 1;
  bufferedAmount?: number;
} = {}) {
  const sent: Sent[] = [];
  const socket = {
    role: options.role ?? 'monitor',
    readyState: options.readyState ?? WebSocket.OPEN,
    monitorPacketVersion: options.monitorPacketVersion,
    bufferedAmount: options.bufferedAmount ?? 0,
    send(payload: unknown, sendOptions: unknown) {
      sent.push({ payload, options: sendOptions });
    },
  } as unknown as RelaySocket;
  return { socket, sent };
}

function fakeServer(...sockets: RelaySocket[]) {
  return { clients: new Set(sockets) } as unknown as WebSocketServer;
}

test('monitor socket transport validates its backlog budget', () => {
  assert.throws(
    () => createMonitorSocketTransport(fakeServer(), { backlogBytes: 0 }),
    /backlogBytes must be positive/,
  );
});

test('monitor socket transport targets only open monitor-role sockets', () => {
  const monitor = fakeSocket();
  const publisher = fakeSocket({ role: 'publisher' });
  const closed = fakeSocket({ readyState: WebSocket.CLOSED });
  const transport = createMonitorSocketTransport(
    fakeServer(monitor.socket, publisher.socket, closed.socket),
    { backlogBytes: 1_000 },
  );

  transport.broadcast('status');

  assert.deepEqual(monitor.sent, [{ payload: 'status', options: { binary: false } }]);
  assert.deepEqual(publisher.sent, []);
  assert.deepEqual(closed.sent, []);
});

test('positioned monitor gets framed PCM while legacy monitor stays raw', () => {
  const framed = fakeSocket({ monitorPacketVersion: 1 });
  const legacy = fakeSocket();
  const transport = createMonitorSocketTransport(fakeServer(framed.socket, legacy.socket), {
    backlogBytes: 10_000,
  });
  const pcm = Buffer.from([1, 0, 2, 0]);

  transport.broadcast(pcm, true, { generation: 7, firstSampleIndex: 960 });

  assert.equal(framed.sent.length, 1);
  assert.equal(legacy.sent.length, 1);
  const framedPacket = decodePcmFrame(framed.sent[0].payload as Buffer);
  assert.equal(framedPacket.generation, 7);
  assert.equal(framedPacket.firstSampleIndex, 960);
  assert.deepEqual(framedPacket.pcm, pcm);
  assert.deepEqual(legacy.sent[0], { payload: pcm, options: { binary: true } });
});

test('positioned monitors share one framed packet per broadcast', () => {
  const first = fakeSocket({ monitorPacketVersion: 1 });
  const second = fakeSocket({ monitorPacketVersion: 1 });
  const third = fakeSocket({ monitorPacketVersion: 1 });
  const transport = createMonitorSocketTransport(
    fakeServer(first.socket, second.socket, third.socket),
    { backlogBytes: 10_000 },
  );

  transport.broadcast(Buffer.from([1, 0, 2, 0]), true, { generation: 7, firstSampleIndex: 960 });
  transport.broadcast(Buffer.from([3, 0, 4, 0]), true, { generation: 7, firstSampleIndex: 962 });

  const [firstA, firstB] = first.sent.map((sent) => sent.payload);
  assert.equal(second.sent[0].payload, firstA, 'framed once, not once per listener');
  assert.equal(third.sent[0].payload, firstA);
  assert.notEqual(firstB, firstA, 'each broadcast frames its own packet');
  assert.equal(second.sent[1].payload, firstB);
  assert.equal(decodePcmFrame(firstB as Buffer).firstSampleIndex, 962);
});

test('positioned monitor never silently receives unpositioned binary PCM', () => {
  const framed = fakeSocket({ monitorPacketVersion: 1 });
  const legacy = fakeSocket();
  const transport = createMonitorSocketTransport(fakeServer(framed.socket, legacy.socket), {
    backlogBytes: 10_000,
  });
  const pcm = Buffer.alloc(8);

  transport.broadcast(pcm, true);

  assert.deepEqual(framed.sent, []);
  assert.equal(legacy.sent.length, 1);
});

test('binary backlog drops are transport-owned and counted per destination', () => {
  const congestedA = fakeSocket({ bufferedAmount: 100 });
  const congestedB = fakeSocket({ bufferedAmount: 100 });
  const clear = fakeSocket({ bufferedAmount: 0 });
  const transport = createMonitorSocketTransport(
    fakeServer(congestedA.socket, congestedB.socket, clear.socket),
    { backlogBytes: 100 },
  );

  transport.broadcast(Buffer.alloc(8), true, { generation: 1, firstSampleIndex: 0 });

  assert.deepEqual(congestedA.sent, []);
  assert.deepEqual(congestedB.sent, []);
  assert.equal(clear.sent.length, 1);
  assert.equal(transport.droppedFrames, 2);

  transport.broadcast('health');
  assert.equal(congestedA.sent.length, 1, 'text control/status traffic is not PCM-backpressure dropped');
  assert.equal(transport.droppedFrames, 2);
});

test('recent drops describe the listeners behind now, not the lifetime total', () => {
  let nowMs = 0;
  const slow = fakeSocket({ bufferedAmount: 100 });
  const clear = fakeSocket({ bufferedAmount: 0 });
  const transport = createMonitorSocketTransport(fakeServer(slow.socket, clear.socket), {
    backlogBytes: 100,
    nowMs: () => nowMs,
  });

  transport.broadcast(Buffer.alloc(8), true, { generation: 1, firstSampleIndex: 0 });
  nowMs = 20;
  transport.broadcast(Buffer.alloc(8), true, { generation: 1, firstSampleIndex: 960 });
  assert.deepEqual(transport.recentDrops(), { frames: 2, listeners: 1, windowMs: 10_000 });

  // The slow phone catches up; its drops age out of the window.
  (slow.socket as { bufferedAmount: number }).bufferedAmount = 0;
  nowMs = 10_019;
  transport.broadcast(Buffer.alloc(8), true, { generation: 1, firstSampleIndex: 1_920 });
  assert.equal(transport.recentDrops().frames, 1);
  nowMs = 10_020;
  assert.deepEqual(transport.recentDrops(), { frames: 0, listeners: 0, windowMs: 10_000 });
  assert.equal(transport.droppedFrames, 2, 'the lifetime total is unchanged');
});

test('a listener that has left is not reported as behind', () => {
  const slow = fakeSocket({ bufferedAmount: 100 });
  const transport = createMonitorSocketTransport(fakeServer(slow.socket), {
    backlogBytes: 100,
    nowMs: () => 0,
  });
  transport.broadcast(Buffer.alloc(8), true, { generation: 1, firstSampleIndex: 0 });
  assert.equal(transport.recentDrops().listeners, 1);

  (slow.socket as { readyState: number }).readyState = WebSocket.CLOSED;
  assert.deepEqual(transport.recentDrops(), { frames: 1, listeners: 0, windowMs: 10_000 });
});

const FRAME = 960;

function positionedFrame(transport: ReturnType<typeof createMonitorSocketTransport>, index: number, generation = 1) {
  transport.broadcast(Buffer.alloc(FRAME * 2), true, { generation, firstSampleIndex: index * FRAME });
}

function ack(
  transport: ReturnType<typeof createMonitorSocketTransport>,
  socket: RelaySocket,
  receivedEndSampleIndex: number,
  generation = 1,
) {
  return transport.acknowledge(socket, { type: 'monitor-ack', generation, receivedEndSampleIndex });
}

test('a monitor that never confirms delivery is only limited by its own socket buffer', () => {
  const listener = fakeSocket({ monitorPacketVersion: 1 });
  const transport = createMonitorSocketTransport(fakeServer(listener.socket), {
    backlogBytes: 1_000_000,
    unacknowledgedSamples: FRAME * 5,
  });
  for (let index = 0; index < 50; index += 1) positionedFrame(transport, index);
  assert.equal(listener.sent.length, 50);
  assert.equal(transport.droppedFrames, 0);
});

test('a confirming monitor stops receiving once too much is outstanding, and rejoins after catching up', () => {
  const listener = fakeSocket({ monitorPacketVersion: 1 });
  const transport = createMonitorSocketTransport(fakeServer(listener.socket), {
    backlogBytes: 1_000_000,
    unacknowledgedSamples: FRAME * 5,
    nowMs: () => 0,
  });
  positionedFrame(transport, 0);
  assert.equal(ack(transport, listener.socket, FRAME), true);

  // The link stalls downstream: the socket buffer stays empty, no acks come.
  for (let index = 1; index <= 10; index += 1) positionedFrame(transport, index);
  const sentIndexes = () => listener.sent.map((sent) => decodePcmFrame(sent.payload as Buffer).firstSampleIndex! / FRAME);
  assert.deepEqual(sentIndexes(), [0, 1, 2, 3, 4, 5, 6], 'sending stops past five outstanding frames');
  assert.deepEqual(transport.recentDrops(), { frames: 4, listeners: 1, windowMs: 10_000 });

  // The stalled audio finally arrives and is confirmed.
  ack(transport, listener.socket, FRAME * 7);
  positionedFrame(transport, 11);
  assert.deepEqual(sentIndexes(), [0, 1, 2, 3, 4, 5, 6, 11], 'the hole brings the listener to the live edge');
});

test('a confirmation from an earlier mix generation confirms nothing of the current one', () => {
  const listener = fakeSocket({ monitorPacketVersion: 1 });
  const transport = createMonitorSocketTransport(fakeServer(listener.socket), {
    backlogBytes: 1_000_000,
    unacknowledgedSamples: FRAME * 3,
  });
  positionedFrame(transport, 0, 1);
  ack(transport, listener.socket, FRAME, 1);
  for (let index = 0; index < 6; index += 1) positionedFrame(transport, index, 2);
  assert.equal(listener.sent.length, 1 + 4);
  ack(transport, listener.socket, FRAME * 4, 2);
  positionedFrame(transport, 6, 2);
  assert.equal(listener.sent.length, 6);
});

test('monitor acknowledgements are validated and never move backwards', () => {
  const listener = fakeSocket({ monitorPacketVersion: 1 });
  const legacy = fakeSocket();
  const publisher = fakeSocket({ role: 'publisher' });
  const transport = createMonitorSocketTransport(fakeServer(listener.socket), {
    backlogBytes: 1_000_000,
    unacknowledgedSamples: FRAME,
  });

  assert.equal(transport.acknowledge(listener.socket, { type: 'clock-ping' }), false);
  for (const bad of [
    { type: 'monitor-ack', generation: -1, receivedEndSampleIndex: 0 },
    { type: 'monitor-ack', generation: 2 ** 32, receivedEndSampleIndex: 0 },
    { type: 'monitor-ack', generation: 1, receivedEndSampleIndex: 1.5 },
    { type: 'monitor-ack', generation: 1, receivedEndSampleIndex: '960' },
  ]) {
    assert.equal(transport.acknowledge(listener.socket, bad), true);
    assert.equal(listener.socket.monitorDelivery, undefined);
  }
  assert.equal(ack(transport, legacy.socket, FRAME), true);
  assert.equal(legacy.socket.monitorDelivery, undefined, 'only positioned monitors confirm delivery');
  assert.equal(ack(transport, publisher.socket, FRAME), true);
  assert.equal(publisher.socket.monitorDelivery, undefined);

  ack(transport, listener.socket, FRAME * 4);
  ack(transport, listener.socket, FRAME * 2);
  assert.deepEqual(listener.socket.monitorDelivery?.acknowledged, { generation: 1, endSampleIndex: FRAME * 4 });
});

test('Listen confirms delivered monitor PCM and Relay routes it to the monitor transport', async () => {
  const { readFile } = await import('node:fs/promises');
  const listen = await readFile(new URL('../public/listen.js', import.meta.url), 'utf8');
  const server = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
  assert.match(listen, /if \(received\.action !== 'accept'\) return;[\s\S]{0,200}acknowledgeMonitorFrame\(next, received\.frame\);/);
  assert.match(listen, /type: 'monitor-ack',\s*generation: frame\.generation,\s*receivedEndSampleIndex: frame\.firstSampleIndex \+ frame\.sampleCount,/);
  assert.match(server, /if \(monitorTransport\.acknowledge\(socket, payload\)\) return;/);
  assert.match(server, /unacknowledgedSamples: MONITOR_UNACKNOWLEDGED_SAMPLES/);
});
