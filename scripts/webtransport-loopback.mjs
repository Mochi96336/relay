import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { WebTransport, quicheLoaded } from '@fails-components/webtransport';
import { encodeAudioPacket } from '../src/audio-packet.ts';
import { MicRuntime } from '../src/mic-runtime.ts';
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
const generation = 7;
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

  const publisherSocket = {
    readyState: 1,
    role: 'publisher',
    isAlive: true,
    participantId: 'loopback-publisher',
    send() {},
    close() {},
    terminate() {},
  };
  const mic = new MicRuntime({
    audioTransportConfig: {
      reorderWindowPackets: 0,
      reorderDeadlineMs: 0,
      maxForwardJumpPackets: 32,
    },
    firstFrameTimeoutMs: 3_000,
    streamLiveMs: 1_000,
    uplinkHealthTimeoutMs: 60_000,
    createDirectMediaTicket: () => ticket,
    directMediaConnected: (candidate) => Boolean(server?.hasSession(candidate)),
    offerDirectMedia: (candidate) => server?.offer(candidate),
  });
  mic.bindPublisher({
    socket: publisherSocket,
    sampleRate: 48_000,
    captureGeneration: generation,
    audioPacketVersion: 2,
    nowMs: 0,
  });
  assert.equal(mic.mediaTicket, ticket);

  let dropBeforeRelayIngress = false;
  let acceptedPackets = 0;
  let acceptedEndSampleIndex = null;
  let nextAccepted = null;
  let nextDropped = null;
  const accepted = () => new Promise((resolve) => { nextAccepted = resolve; });
  const dropped = () => new Promise((resolve) => { nextDropped = resolve; });

  timeout = setTimeout(() => {
    nextAccepted?.(new Error('timed out waiting for accepted WebTransport datagram'));
    nextDropped?.(new Error('timed out waiting for dropped WebTransport datagram'));
  }, 5000);

  server = await startWebTransportMediaServer(config, {
    authorize(candidate) {
      return mic.authorizeDirectMedia(candidate);
    },
    onDatagram(candidate, packet, nowMs) {
      if (dropBeforeRelayIngress) {
        const resolve = nextDropped;
        nextDropped = null;
        resolve?.({ candidate, packet: Buffer.from(packet), nowMs });
        return;
      }

      const frames = mic.receiveDirectMedia(candidate, packet, nowMs);
      for (const frame of frames) {
        acceptedPackets += 1;
        acceptedEndSampleIndex = frame.firstSampleIndex + frame.pcm.byteLength / 2;
        if (frame.pcm.byteLength > 0) mic.noteFrame(nowMs);
      }
      const resolve = nextAccepted;
      nextAccepted = null;
      resolve?.({ candidate, frames, nowMs });
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

  // First prove the ordinary native HTTP/3 path reaches Relay's current
  // generation receiver and establishes an accepted sample frontier.
  const firstAccepted = accepted();
  const firstPacket = encodeAudioPacket({
    source: 'mic',
    generation,
    sequence: 0,
    firstSampleIndex: 0,
    pcm: Buffer.alloc(4, 1),
  });
  await writer.write(new Uint8Array(firstPacket));
  const first = await firstAccepted;
  if (first instanceof Error) throw first;
  assert.equal(first.candidate, ticket);
  assert.equal(first.frames.length, 1);
  assert.equal(acceptedPackets, 1);
  assert.equal(acceptedEndSampleIndex, 2);
  assert.equal(mic.receiverStats()?.emittedPackets, 1);
  assert.equal(server.hasSession(ticket), true);

  // Now model the missing fault class. QUIC/WebTransport accepts the datagram
  // and writer.write() resolves, but the test-only ingress gate swallows the
  // packet before MicRuntime receives it. This is deliberately outside
  // production runtime: it proves sender completion is not server PCM proof.
  dropBeforeRelayIngress = true;
  const secondDropped = dropped();
  const secondPacket = encodeAudioPacket({
    source: 'mic',
    generation,
    sequence: 1,
    firstSampleIndex: 2,
    pcm: Buffer.alloc(4, 2),
  });
  await writer.write(new Uint8Array(secondPacket));
  const lost = await secondDropped;
  if (lost instanceof Error) throw lost;

  assert.equal(lost.candidate, ticket);
  assert.equal(lost.packet.byteLength, secondPacket.byteLength);
  assert.equal(acceptedPackets, 1, 'resolved writer must not imply a Relay-accepted PCM packet');
  assert.equal(acceptedEndSampleIndex, 2, 'current-generation accepted sample frontier must remain unchanged');
  assert.equal(mic.receiverStats()?.receivedPackets, 1, 'dropped datagram never reaches the AudioPacket receiver');
  assert.equal(mic.receiverStats()?.emittedPackets, 1);

  console.log('native WebTransport HTTP/3 writer resolve + Relay PCM ingress-drop proof passed');
  mic.clearMediaAuthority(0);
} finally {
  if (timeout) clearTimeout(timeout);
  try { writer?.releaseLock(); } catch {}
  try { client?.close(); } catch {}
  if (server) await server.stop();
  await rm(tempDirectory, { recursive: true, force: true });
}
