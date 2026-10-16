import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = `${readFileSync(new URL('../public/ws-url.js', import.meta.url), 'utf8')
  .replace(/^export /m, '')}\nglobalThis.result = wsUrl(globalThis.options);\n`;

function wsUrlFor(href: string, options?: { compress?: boolean; direct?: boolean }, directMeta?: string) {
  const url = new URL(href);
  const context: Record<string, unknown> = {
    URL,
    URLSearchParams,
    location: { protocol: url.protocol, host: url.host, search: url.search },
    options,
  };
  if (directMeta !== undefined) {
    context.document = {
      querySelector: (selector: string) => selector === 'meta[name="relay-direct-socket"]'
        ? { getAttribute: () => directMeta }
        : null,
    };
  }
  runInNewContext(source, context);
  return context.result;
}

test('a page socket carries only the page key', () => {
  const audio = { compress: false };
  assert.equal(wsUrlFor('http://relay.local:8080/listen.html', audio), 'ws://relay.local:8080/ws');
  assert.equal(
    wsUrlFor('https://relay.example/listen.html?key=a%20b%26c&participant=1', audio),
    'wss://relay.example/ws?key=a+b%26c',
  );
  assert.equal(wsUrlFor('https://relay.example/?key=', audio), 'wss://relay.example/ws');
});

test('a status socket offers compression and an audio socket does not', () => {
  assert.equal(wsUrlFor('http://relay.local:8080/'), 'ws://relay.local:8080/ws?compress=1');
  assert.equal(
    wsUrlFor('https://relay.example/?key=abc'),
    'wss://relay.example/ws?key=abc&compress=1',
  );
  assert.equal(wsUrlFor('https://relay.example/?key=abc', { compress: false }), 'wss://relay.example/ws?key=abc');
});

test('the sockets that carry audio never ask for compression', () => {
  // A browser compresses everything it sends on a compressed socket, so the
  // singer's PCM uplink and Listen's room audio must stay off it.
  for (const page of ['app.js', 'listen.js']) {
    const pageSource = readFileSync(new URL(`../public/${page}`, import.meta.url), 'utf8');
    assert.match(pageSource, /wsUrl\(\{ compress: false[ ,}]/, page);
    assert.doesNotMatch(pageSource, /wsUrl\(\)/, page);
    assert.doesNotMatch(pageSource, /wsUrl\(\{ direct: true/, page);
  }
});

test('a Mic socket asks for the direct socket and falls back to the page host', () => {
  const audio = { compress: false, direct: true };
  assert.equal(
    wsUrlFor('https://relay.example/?key=abc', audio, 'wss://media.example:4433/ws'),
    'wss://media.example:4433/ws?key=abc',
  );
  assert.equal(wsUrlFor('https://relay.example/?key=abc', audio), 'wss://relay.example/ws?key=abc', 'no document');
  assert.equal(wsUrlFor('https://relay.example/', audio, ''), 'wss://relay.example/ws', 'no offer');
  assert.equal(wsUrlFor('https://relay.example/', audio, 'ws://media.example/ws'), 'wss://relay.example/ws', 'never plain ws');
  assert.equal(wsUrlFor('https://relay.example/', audio, 'not a url'), 'wss://relay.example/ws');
  assert.equal(
    wsUrlFor('https://relay.example/', { compress: false }, 'wss://media.example:4433/ws'),
    'wss://relay.example/ws',
    'only a socket that asks goes direct',
  );
});
