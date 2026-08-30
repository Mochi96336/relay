import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import WebSocket from 'ws';

import { createRelayWebSocketServer, type RelaySocket } from '../src/relay-socket-server.js';

const TIMEOUT_MS = 2_000;

type EventTarget = {
  once: (event: string, listener: (...args: any[]) => void) => unknown;
  off: (event: string, listener: (...args: any[]) => void) => unknown;
};

function waitForEvent(target: EventTarget, event: string) {
  return new Promise<any[]>((resolve, reject) => {
    const listener = (...args: any[]) => {
      clearTimeout(timer);
      resolve(args);
    };
    const timer = setTimeout(() => {
      target.off(event, listener);
      reject(new Error('Timed out waiting for ' + event + '.'));
    }, TIMEOUT_MS);
    target.once(event, listener);
  });
}

function listen(server: ReturnType<typeof createServer>) {
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Expected an ephemeral TCP address.'));
        return;
      }
      resolve(address.port);
    });
  });
}

async function close(server: ReturnType<typeof createServer>, wss: ReturnType<typeof createRelayWebSocketServer>) {
  for (const client of wss.clients) client.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  server.closeAllConnections();
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
}

test('socket adapter assigns one monotonic incarnation to each accepted physical WebSocket', { timeout: 10_000 }, async () => {
  const server = createServer();
  const wss = createRelayWebSocketServer(server, { relayKey: null, heartbeatMs: 60_000 });
  const port = await listen(server);
  let firstClient: WebSocket | null = null;
  let secondClient: WebSocket | null = null;

  try {
    const firstAccepted = waitForEvent(wss, 'connection');
    firstClient = new WebSocket('ws://127.0.0.1:' + port + '/ws');
    await waitForEvent(firstClient, 'open');
    const [firstRaw] = await firstAccepted;
    const first = firstRaw as RelaySocket;

    const secondAccepted = waitForEvent(wss, 'connection');
    secondClient = new WebSocket('ws://127.0.0.1:' + port + '/ws');
    await waitForEvent(secondClient, 'open');
    const [secondRaw] = await secondAccepted;
    const second = secondRaw as RelaySocket;

    assert.equal(first.connectionIncarnation, 1);
    assert.equal(second.connectionIncarnation, 2);
    assert.notEqual(first.connectionIncarnation, second.connectionIncarnation);
  } finally {
    firstClient?.terminate();
    secondClient?.terminate();
    await close(server, wss);
  }
});

test('server consumes adapter-owned incarnation without allocating a second identity sequence', async () => {
  const serverSource = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
  const socketSource = await readFile(new URL('../src/relay-socket-server.ts', import.meta.url), 'utf8');

  assert.doesNotMatch(serverSource, /participantConnectionSequence|legacyPlaybackConnectionSequence|legacyPlaybackGeneration/);
  assert.match(serverSource, /participantConnectionId = .*socket\.connectionIncarnation/);
  assert.match(serverSource, /playbackGeneration = socket\.connectionIncarnation;/);

  assert.match(socketSource, /connectionIncarnation: number;/);
  assert.match(socketSource, /let connectionSequence = 0;/);
  assert.match(socketSource, /connectionSequence \+= 1;\s*socket\.connectionIncarnation = connectionSequence;/);
  assert.doesNotMatch(socketSource, /ParticipantSession|SongSession|LEGACY_PLAYBACK|participantConnectionId =/);
});
