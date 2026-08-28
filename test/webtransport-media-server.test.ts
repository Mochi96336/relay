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

    assert.equal(media.available, false);
    assert.equal(media.offer('ticket'), undefined);
    assert.equal(media.hasSession('ticket'), false);
    await media.stop();
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0]?.[0]), /WebSocket microphone fallback/);
});

it('logs direct-media listening only when HTTP/3 actually started', () => {
  const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');

  assert.match(
    server,
    /if \(webTransportMedia\.available\) \{[\s\S]{0,300}Relay WebTransport media listening/ ,
    'the no-op fallback must not emit a false listening success message',
  );
});

it('retires direct-media authority at every Mic ownership terminal boundary', () => {
  const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');

  assert.match(
    server,
    /participants\.releaseMic\(expectedOwnerId, 'transport-expired'\)[\s\S]{0,500}clearMicMediaAuthority\(\)[\s\S]{0,500}applyMicOwnerEffects\(released\.effects\)/,
    'Mic transport-grace expiry must retire WebTransport authority while applying canonical room effects',
  );
  assert.match(
    server,
    /presenceSweep\.releasedMicOwnerId && presenceSweep\.micOwnerEffects[\s\S]{0,800}applyMicOwnerEffects\(presenceSweep\.micOwnerEffects, nowMs, \{[\s\S]{0,500}clearMicMediaAuthority\(\)[\s\S]{0,500}publishFullHandoffStatus: false/,
    'participant expiry must retire media authority inside the canonical effect epoch without adding a full Song-status broadcast',
  );
  assert.match(
    server,
    /wss\.on\('close'[\s\S]{0,500}clearMicMediaAuthority\(\)/,
    'WebSocket shutdown must still retire direct-media authority',
  );
  assert.match(
    server,
    /async function gracefulShutdown\(signal: NodeJS\.Signals\)[\s\S]{0,2000}clearInterval\(mixerTimer\)[\s\S]{0,2000}await takeController\.shutdown\(Date\.now\(\)\)[\s\S]{0,1000}await webTransportMedia\?\.stop\(\)[\s\S]{0,1000}for \(const client of wss\.clients\) client\.terminate\(\)[\s\S]{0,1000}wss\.close/,
    'controlled process shutdown must freeze mixing, await Take and HTTP/3 finalization, then close sockets',
  );
  assert.match(
    server,
    /let shuttingDown = false;[\s\S]{0,400}wss\.on\('connection'[\s\S]{0,300}if \(shuttingDown\) \{[\s\S]{0,200}socket\.close\(1012/,
    'controlled shutdown must reject connections opened after the shutdown fence is raised',
  );
  assert.match(
    server,
    /socket\.on\('message', \(data, isBinary\) => \{\s*if \(shuttingDown\) return;/,
    'existing WebSocket clients must not mutate Relay state after controlled shutdown begins',
  );
  assert.match(
    server,
    /async function gracefulShutdown\(signal: NodeJS\.Signals\) \{\s*if \(shutdownPromise\) return shutdownPromise;\s*shuttingDown = true;/,
    'the shutdown fence must rise before asynchronous Take finalization yields back to socket handlers',
  );
  assert.match(
    server,
    /for \(const signal of \['SIGTERM', 'SIGINT'\] as const\) \{\s*process\.on\(signal,/,
    'repeated controlled-shutdown signals must keep joining the shared shutdown transaction',
  );
});
