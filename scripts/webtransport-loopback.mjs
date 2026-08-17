import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { WebTransport, quicheLoaded } from '@fails-components/webtransport';
import {
  startWebTransportMediaServer,
  webTransportMediaConfig,
} from '../src/webtransport-media-server.ts';

const port = Number(process.env.RELAY_WEBTRANSPORT_LOOPBACK_PORT ?? 44337);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new RangeError('RELAY_WEBTRANSPORT_LOOPBACK_PORT must be an integer from 1024 to 65535');
}

const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'relay-webtransport-loopback-'));
const keyPath = path.join(tempDirectory, 'key.pem');
const certPath = path.join(tempDirectory, 'cert.pem');
const ticket = 'loopback-ticket';
let server = null;
let client = null;
let writer = null;
let timeout = null;

try {
  execFileSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', keyPath]);
  execFileSync('openssl', [
    'req', '-new', '-x509',
    '-key', keyPath,
    '-out', certPath,
    '-days', '1',
    '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1',
  ]);

  const config = webTransportMediaConfig({
    RELAY_WEBTRANSPORT_PUBLIC_URL: `https://127.0.0.1:${port}/media`,
    RELAY_WEBTRANSPORT_HOST: '127.0.0.1',
    RELAY_WEBTRANSPORT_CERT: certPath,
    RELAY_WEBTRANSPORT_KEY: keyPath,
    RELAY_WEBTRANSPORT_PIN_CERT: '1',
  });
  assert.ok(config);

  let resolveDatagram;
  let rejectDatagram;
  const received = new Promise((resolve, reject) => {
    resolveDatagram = resolve;
    rejectDatagram = reject;
  });
  timeout = setTimeout(() => rejectDatagram(new Error('timed out waiting for WebTransport datagram')), 5000);

  server = await startWebTransportMediaServer(config, {
    authorize(candidate) {
      return candidate === ticket;
    },
    onDatagram(candidate, packet) {
      if (candidate === ticket) resolveDatagram(packet);
    },
  });

  const offer = server.offer(ticket);
  assert.equal(offer.preferred, 'webtransport');
  assert.equal(offer.serverCertificateHashes?.length, 1);

  await quicheLoaded;
  const hashes = offer.serverCertificateHashes.map((hash) => ({
    algorithm: hash.algorithm,
    value: Buffer.from(hash.valueBase64, 'base64'),
  }));
  client = new WebTransport(offer.url, {
    requireUnreliable: true,
    congestionControl: 'low-latency',
    serverCertificateHashes: hashes,
    quicConnectTimeout: 3000,
    webTransportConnectTimeout: 3000,
  });

  await client.ready;
  assert.equal(client.reliability, 'supports-unreliable');
  writer = client.datagrams.createWritable().getWriter();
  await writer.ready;

  const payload = Uint8Array.from({ length: 1200 }, (_, index) => index & 0xff);
  await writer.write(payload);
  const packet = await received;
  assert.equal(packet.byteLength, 1200);
  assert.deepEqual([...packet.subarray(0, 8)], [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(server.hasSession(ticket), true);
  console.log('native WebTransport HTTP/3 handshake + 1200-byte datagram loopback passed');
} finally {
  if (timeout) clearTimeout(timeout);
  try { writer?.releaseLock(); } catch {}
  try { client?.close(); } catch {}
  if (server) await server.stop();
  await rm(tempDirectory, { recursive: true, force: true });
}
