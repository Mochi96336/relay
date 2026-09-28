import assert from 'node:assert/strict';
import { request } from 'node:http';
import test from 'node:test';

import WebSocket from 'ws';

import { RelayClient, startRelay } from './helpers/harness.js';

function negotiated(client: RelayClient) {
  return String((client as unknown as { socket: { extensions: string } }).socket.extensions);
}

test('only a socket that asks negotiates status compression, and only when Relay enables it', async () => {
  for (const enabled of [true, false]) {
    const server = await startRelay({ RELAY_STATUS_DEFLATE: enabled ? '1' : '0' });
    const clients: RelayClient[] = [];
    try {
      // The ws client offers permessage-deflate on every connection, as browsers do.
      const asking = await RelayClient.connect(server, '?compress=1');
      const plain = await RelayClient.connect(server);
      clients.push(asking, plain);

      assert.equal(
        negotiated(asking).includes('permessage-deflate'),
        enabled,
        `a socket that asks is compressed only when Relay enables it (enabled=${enabled})`,
      );
      assert.equal(negotiated(plain), '', 'a socket that does not ask is never compressed');

      for (const client of clients) {
        client.send({ type: 'source-status-request' });
        const status = await client.waitForType('source-status');
        assert.equal(status.type, 'source-status', 'status still arrives intact');
      }
    } finally {
      for (const client of clients) client.close();
      await server.stop();
    }
  }
});

/** Status line and negotiated extensions of one raw WebSocket upgrade. */
function upgrade(url: string, extensions: string) {
  return new Promise<{ status: number; extensions: string }>((resolve, reject) => {
    const req = request(url, {
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Extensions': extensions,
      },
    });
    req.on('upgrade', (response, socket) => {
      socket.destroy();
      resolve({
        status: response.statusCode ?? 0,
        extensions: String(response.headers['sec-websocket-extensions'] ?? ''),
      });
    });
    req.on('response', (response) => {
      response.resume();
      resolve({ status: response.statusCode ?? 0, extensions: '' });
    });
    req.on('error', reject);
    req.end();
  });
}

test('every browser offer that asks for status compression connects, and is compressed', async () => {
  const server = await startRelay({ RELAY_STATUS_DEFLATE: '1' });
  try {
    const url = server.wsUrl('?compress=1').replace(/^ws/, 'http');
    // WebKit (iPhone Safari) offers the extension with no parameters. A server
    // that insists on sizing the client's window has to refuse that offer, and
    // ws refuses it by failing the whole handshake with 400: every status
    // socket on an iPhone stayed "connecting" while its audio played on.
    for (const offer of [
      'permessage-deflate',
      'permessage-deflate; client_max_window_bits',
      'permessage-deflate; client_max_window_bits=15',
    ]) {
      const result = await upgrade(url, offer);
      assert.equal(result.status, 101, `offer "${offer}" must connect`);
      assert.match(result.extensions, /permessage-deflate/, `offer "${offer}" must be compressed`);
    }

    // And a parameterless offer carries status both ways once it is open. With
    // `false`, ws offers no client_max_window_bits, as WebKit does; @types/ws
    // only admits a number there.
    const webKitOffer = { clientMaxWindowBits: false } as unknown as WebSocket.PerMessageDeflateOptions;
    const socket = new WebSocket(server.wsUrl('?compress=1'), { perMessageDeflate: webKitOffer });
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    try {
      assert.match(socket.extensions, /permessage-deflate/);
      const status = new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no source-status')), 5_000);
        socket.on('message', (data, isBinary) => {
          if (isBinary) return;
          const message = JSON.parse(String(data));
          if (message.type !== 'source-status') return;
          clearTimeout(timer);
          resolve(message);
        });
      });
      socket.send(JSON.stringify({ type: 'source-status-request' }));
      assert.equal((await status).type, 'source-status');
    } finally {
      socket.close();
    }
  } finally {
    await server.stop();
  }
});
