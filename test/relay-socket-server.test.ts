import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import WebSocket from 'ws';

import {
  createRelaySocketTransport,
  createRelayWebSocketServer,
  type RelaySocket,
} from '../src/relay-socket-server.js';

const PHASE_TIMEOUT_MS = 2_000;

type EventTarget = {
  once: (event: string, listener: (...args: any[]) => void) => unknown;
  off: (event: string, listener: (...args: any[]) => void) => unknown;
};

function waitForEvent(target: EventTarget, event: string, label: string) {
  return new Promise<any[]>((resolve, reject) => {
    const onEvent = (...args: any[]) => {
      clearTimeout(timer);
      resolve(args);
    };
    const timer = setTimeout(() => {
      target.off(event, onEvent);
      reject(new Error(`Timed out waiting for ${label}.`));
    }, PHASE_TIMEOUT_MS);
    target.once(event, onEvent);
  });
}

function listen(server: ReturnType<typeof createServer>) {
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for HTTP listen.')), PHASE_TIMEOUT_MS);
    server.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    server.listen(0, '127.0.0.1', () => {
      clearTimeout(timer);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Expected an ephemeral TCP address.'));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: ReturnType<typeof createServer>) {
  if (!server.listening) return Promise.resolve();
  server.closeAllConnections();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out closing HTTP server.')), PHASE_TIMEOUT_MS);
    server.close((error) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    });
  });
}

function closeWebSocketServer(wss: ReturnType<typeof createRelayWebSocketServer>) {
  for (const client of wss.clients) client.terminate();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out closing WebSocket server.')), PHASE_TIMEOUT_MS);
    wss.close((error) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    });
  });
}

test('socket substrate owns upgrade admission and initializes transport metadata', { timeout: 10_000 }, async () => {
  const server = createServer();
  const wss = createRelayWebSocketServer(server, {
    relayKey: 'secret',
    heartbeatMs: 1_000,
  });
  const transport = createRelaySocketTransport(wss);
  const port = await listen(server);

  try {
    const unauthorized = new WebSocket(`ws://127.0.0.1:${port}/ws?key=wrong`);
    const unauthorizedError = waitForEvent(unauthorized, 'error', 'unauthorized WebSocket error');
    const unauthorizedClosed = waitForEvent(unauthorized, 'close', 'unauthorized WebSocket close');
    const [error] = await unauthorizedError;
    assert.match((error as Error).message, /Unexpected server response: 401/);
    await unauthorizedClosed;

    const accepted = waitForEvent(wss, 'connection', 'accepted WebSocket connection');
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws?key=secret`);
    await waitForEvent(client, 'open', 'accepted client open');
    const [rawSocket] = await accepted;
    const socket = rawSocket as RelaySocket;

    assert.equal(socket.role, 'unknown');
    assert.equal(socket.isAlive, true);

    socket.isAlive = false;
    const serverMessage = waitForEvent(socket, 'message', 'accepted server message traffic');
    client.send(JSON.stringify({ type: 'clock-ping' }));
    await serverMessage;
    assert.equal(socket.isAlive, true, 'message traffic refreshes heartbeat liveness');

    const directMessage = waitForEvent(client, 'message', 'direct transport JSON');
    transport.sendJson(socket, { type: 'transport-direct' });
    const [directPayload] = await directMessage;
    assert.deepEqual(JSON.parse(directPayload.toString()), { type: 'transport-direct' });

    assert.equal(transport.canClaimSocketRole(socket, 'publisher'), true);
    transport.commitSocketRole(socket, 'publisher');
    assert.equal(socket.role, 'publisher');
    assert.equal(transport.canClaimSocketRole(socket, 'publisher'), true);

    const conflictMessage = waitForEvent(client, 'message', 'role conflict JSON');
    assert.equal(transport.canClaimSocketRole(socket, 'backing'), false);
    const [conflictPayload] = await conflictMessage;
    assert.deepEqual(JSON.parse(conflictPayload.toString()), {
      type: 'role-conflict',
      currentRole: 'publisher',
      requestedRole: 'backing',
    });
    assert.throws(
      () => transport.commitSocketRole(socket, 'backing'),
      /Cannot change WebSocket role from publisher to backing/,
    );

    const broadcastMessage = waitForEvent(client, 'message', 'broadcast transport JSON');
    transport.broadcastJson({ type: 'transport-broadcast' });
    const [broadcastPayload] = await broadcastMessage;
    assert.deepEqual(JSON.parse(broadcastPayload.toString()), { type: 'transport-broadcast' });

    const retirementMessage = waitForEvent(client, 'message', 'retirement payload');
    const clientClosed = waitForEvent(client, 'close', 'retired client close');
    const serverSocketClosed = waitForEvent(socket, 'close', 'retired server socket close');
    transport.retire(socket, { type: 'transport-retired', message: 'replaced' });
    const [retirementPayload] = await retirementMessage;
    assert.deepEqual(JSON.parse(retirementPayload.toString()), {
      type: 'transport-retired',
      message: 'replaced',
    });
    assert.equal(socket.replaced, true);
    await Promise.all([clientClosed, serverSocketClosed]);
  } finally {
    await closeWebSocketServer(wss);
    await closeServer(server);
  }
});

test('heartbeat terminates a stale socket', { timeout: 10_000 }, async () => {
  const server = createServer();
  const wss = createRelayWebSocketServer(server, {
    relayKey: null,
    heartbeatMs: 100,
  });
  const port = await listen(server);
  let client: WebSocket | null = null;

  try {
    const accepted = waitForEvent(wss, 'connection', 'heartbeat test connection');
    client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await waitForEvent(client, 'open', 'heartbeat test client open');
    const [rawSocket] = await accepted;
    const socket = rawSocket as RelaySocket;

    socket.isAlive = false;
    const clientClosed = waitForEvent(client, 'close', 'stale client termination');
    const serverSocketClosed = waitForEvent(socket, 'close', 'stale server socket termination');
    await Promise.all([clientClosed, serverSocketClosed]);

    assert.equal(socket.readyState, WebSocket.CLOSED);
    assert.equal(client.readyState, WebSocket.CLOSED);
  } finally {
    if (client && client.readyState !== WebSocket.CLOSED) client.terminate();
    await closeWebSocketServer(wss);
    await closeServer(server);
  }
});
