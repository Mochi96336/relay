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
