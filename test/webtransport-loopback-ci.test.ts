import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const loopback = readFileSync(new URL('../scripts/webtransport-loopback.mjs', import.meta.url), 'utf8');

test('real WebTransport loopback is a permanent CI boundary', () => {
  assert.equal(
    packageJson.scripts['test:webtransport-loopback'],
    'node --import tsx scripts/webtransport-loopback.mjs',
  );
  assert.match(ci, /webtransport-loopback:/);
  assert.match(ci, /npm run test:webtransport-loopback/);
  assert.match(loopback, /startWebTransportMediaServer/);
  assert.match(loopback, /length: 1200/);
  assert.match(loopback, /packet\.byteLength, 1200/);
});
