import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { get as httpsGet } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import WebSocket from 'ws';

import { createDirectSocketServer, directSocketConfig } from '../src/direct-socket.js';
import { createRelayWebSocketServer } from '../src/relay-socket-server.js';
import type { WebTransportMediaConfig } from '../src/webtransport-media-server.js';

const media: WebTransportMediaConfig = {
  publicUrl: new URL('https://media.example.test:4433/media'),
  bindHost: '127.0.0.1',
  bindPort: 4433,
  certPath: '/certs/media-cert.pem',
  keyPath: '/certs/media-key.pem',
  pinCertificate: false,
};

test('the direct socket is off unless a port is set and WebTransport names the host', () => {
  assert.equal(directSocketConfig(media, {}), null);
  assert.equal(directSocketConfig(null, { RELAY_DIRECT_SOCKET_PORT: '4433' }), null);
  for (const port of ['0', '65536', '44.3', 'tcp']) {
    assert.equal(directSocketConfig(media, { RELAY_DIRECT_SOCKET_PORT: port }), null, port);
  }
});

test('the direct socket shares the WebTransport name and certificate on its own TCP port', () => {
  const config = directSocketConfig(media, { RELAY_DIRECT_SOCKET_PORT: '8443' });
  assert.ok(config);
  assert.equal(config.publicUrl.toString(), 'wss://media.example.test:8443/ws');
  assert.equal(config.bindHost, '127.0.0.1');
  assert.equal(config.bindPort, 8443);
  assert.equal(config.certPath, media.certPath);
  assert.equal(config.keyPath, media.keyPath);
});

function selfSignedCertificate(dir: string) {
  const certPath = path.join(dir, 'cert.pem');
  const keyPath = path.join(dir, 'key.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=localhost',
  ], { stdio: 'ignore' });
  return { certPath, keyPath };
}

function listen(server: { listen: (port: number, host: string, cb: () => void) => unknown; address: () => unknown }) {
  return new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  });
}

function connect(url: string) {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url, { rejectUnauthorized: false });
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
    socket.once('unexpected-response', (_request, response) => reject(new Error(`HTTP ${response.statusCode}`)));
  });
}

test('the direct TLS server reaches the same Relay sockets and keeps the Relay key', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'relay-direct-socket-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { certPath, keyPath } = selfSignedCertificate(dir);

  const page = createServer();
  const direct = createDirectSocketServer({
    bindHost: '127.0.0.1', bindPort: 0, publicUrl: new URL('wss://localhost/ws'), certPath, keyPath,
  });
  const wss = createRelayWebSocketServer([page, direct], { relayKey: 'sekrit', heartbeatMs: 60_000 });
  const [pagePort, directPort] = await Promise.all([listen(page), listen(direct)]);
  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await Promise.all([page, direct].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  const viaPage = await connect(`ws://127.0.0.1:${pagePort}/ws?key=sekrit`);
  const viaDirect = await connect(`wss://127.0.0.1:${directPort}/ws?key=sekrit`);
  assert.equal(wss.clients.size, 2, 'both doors lead to one socket server');
  viaPage.close();
  viaDirect.close();

  await assert.rejects(connect(`wss://127.0.0.1:${directPort}/ws`), /HTTP 401/);
  const status = await new Promise<number | undefined>((resolve, reject) => {
    httpsGet({ host: '127.0.0.1', port: directPort, path: '/', rejectUnauthorized: false }, (response) => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(status, 404, 'the page itself is never served here');
});
