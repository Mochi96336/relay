import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = `${readFileSync(new URL('../public/ws-url.js', import.meta.url), 'utf8')
  .replace(/^export /m, '')}\nglobalThis.result = wsUrl();\n`;

function wsUrlFor(href: string) {
  const url = new URL(href);
  const context: Record<string, unknown> = {
    URLSearchParams,
    location: { protocol: url.protocol, host: url.host, search: url.search },
  };
  runInNewContext(source, context);
  return context.result;
}

test('a page socket carries only the page key', () => {
  assert.equal(wsUrlFor('http://relay.local:8080/listen.html'), 'ws://relay.local:8080/ws');
  assert.equal(
    wsUrlFor('https://relay.example/listen.html?key=a%20b%26c&participant=1'),
    'wss://relay.example/ws?key=a+b%26c',
  );
  assert.equal(wsUrlFor('https://relay.example/?key='), 'wss://relay.example/ws');
});
