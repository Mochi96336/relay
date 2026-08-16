import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  createWebTransportMediaTicket,
  startWebTransportMediaServer,
  webTransportMediaConfig,
} from '../src/webtransport-media-server.js';

describe('WebTransport media configuration', () => {
  it('is fully disabled when no public direct endpoint is configured', () => {
    assert.equal(webTransportMediaConfig({}), null);
  });

  it('fails open when the optional direct-media configuration is invalid', () => {
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      assert.equal(
        webTransportMediaConfig({ RELAY_WEBTRANSPORT_PUBLIC_URL: 'https://media.example.test/media' }),
        null,
      );
      assert.equal(
        webTransportMediaConfig({ RELAY_WEBTRANSPORT_PUBLIC_URL: 'http://media.example.test:4433/media' }),
        null,
      );
      assert.equal(
        webTransportMediaConfig({ RELAY_WEBTRANSPORT_PUBLIC_URL: 'https://media.example.test:4433/media' }),
        null,
      );
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warnings.length, 3);
    assert.ok(warnings.every((warning) => String(warning[0]).includes('WebSocket microphone fallback')));
  });

  it('derives the bind port from the public URL without confusing it with the HTTP control port', () => {
    const config = webTransportMediaConfig({
      RELAY_WEBTRANSPORT_PUBLIC_URL: 'https://media.example.test:4433/media',
      RELAY_WEBTRANSPORT_CERT: '/run/relay/media.crt',
      RELAY_WEBTRANSPORT_KEY: '/run/relay/media.key',
    });

    assert.ok(config);
    assert.equal(config.bindHost, '0.0.0.0');
    assert.equal(config.bindPort, 4433);
    assert.equal(config.publicUrl.pathname, '/media');
    assert.equal(config.pinCertificate, false);
  });

  it('allows an explicit local bind while keeping the advertised direct URL stable', () => {
    const config = webTransportMediaConfig({
      RELAY_WEBTRANSPORT_PUBLIC_URL: 'https://media.example.test:4433/media',
      RELAY_WEBTRANSPORT_HOST: '192.168.1.20',
      RELAY_WEBTRANSPORT_PORT: '5443',
      RELAY_WEBTRANSPORT_CERT: '/run/relay/media.crt',
      RELAY_WEBTRANSPORT_KEY: '/run/relay/media.key',
      RELAY_WEBTRANSPORT_PIN_CERT: '1',
    });

    assert.ok(config);
    assert.equal(config.bindHost, '192.168.1.20');
    assert.equal(config.bindPort, 5443);
    assert.equal(config.publicUrl.port, '4433');
    assert.equal(config.pinCertificate, true);
  });

  it('issues unguessable capture-scoped capability tickets', () => {
    const first = createWebTransportMediaTicket();
    const second = createWebTransportMediaTicket();
    assert.notEqual(first, second);
    assert.match(first, /^[A-Za-z0-9_-]{32}$/);
  });
});

it('falls back to a no-op direct-media adapter when HTTP/3 startup fails', async () => {
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    const media = await startWebTransportMediaServer({
      publicUrl: new URL('https://media.example.test:4433/media'),
      bindHost: '127.0.0.1',
      bindPort: 4433,
      certPath: '/definitely/missing/relay-media.crt',
      keyPath: '/definitely/missing/relay-media.key',
      pinCertificate: false,
    }, {
      authorize: () => false,
      onDatagram: () => {},
    });

    assert.equal(media.offer('ticket'), undefined);
    assert.equal(media.hasSession('ticket'), false);
    await media.stop();
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0]?.[0]), /WebSocket microphone fallback/);
});

it('retires direct-media authority at every Mic ownership terminal boundary', () => {
  const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');

  assert.match(
    server,
    /participants\.releaseMic\(expectedOwnerId\)[\s\S]{0,500}clearMicMediaAuthority\(\)[\s\S]{0,500}takeController\.noteQualityEvent\('mic-owner-changed'\)[\s\S]{0,500}cancelPendingRoomSongCommand\('mic-owner-released'\)/,
    'Mic transport-grace expiry must retire WebTransport authority without dropping Take/command semantics',
  );
  assert.match(
    server,
    /presenceSweep\.releasedMicOwnerId[\s\S]{0,500}clearMicMediaAuthority\(\)[\s\S]{0,500}cancelPendingRoomSongCommand\('mic-owner-released', nowMs\)[\s\S]{0,500}youtubeTimeline\.cancelHandoff\(\)/,
    'participant expiry must retire media authority and the old owner command/handoff epoch together',
  );
  assert.match(
    server,
    /wss\.on\('close'[\s\S]{0,500}takeController\.shutdown\(\)[\s\S]{0,500}clearMicMediaAuthority\(\)[\s\S]{0,500}webTransportMedia\?\.stop\(\)/,
    'server shutdown must close Take, direct-media authority, and the HTTP\/3 server',
  );
});
