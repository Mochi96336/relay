import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createWebTransportMediaTicket,
  webTransportMediaConfig,
} from '../src/webtransport-media-server.js';

describe('WebTransport media configuration', () => {
  it('is fully disabled when no public direct endpoint is configured', () => {
    assert.equal(webTransportMediaConfig({}), null);
  });

  it('requires a direct HTTPS URL with an explicit HTTP/3 UDP port and keypair', () => {
    assert.throws(
      () => webTransportMediaConfig({ RELAY_WEBTRANSPORT_PUBLIC_URL: 'https://media.example.test/media' }),
      /port explicitly/,
    );
    assert.throws(
      () => webTransportMediaConfig({ RELAY_WEBTRANSPORT_PUBLIC_URL: 'http://media.example.test:4433/media' }),
      /must use https/,
    );
    assert.throws(
      () => webTransportMediaConfig({ RELAY_WEBTRANSPORT_PUBLIC_URL: 'https://media.example.test:4433/media' }),
      /RELAY_WEBTRANSPORT_CERT/,
    );
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
