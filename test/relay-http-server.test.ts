import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createRelayHttpServer } from '../src/relay-http-server.js';

const TAKE_ID = '11111111-1111-4111-8111-111111111111';

async function withHttpServer(
  options: Partial<Parameters<typeof createRelayHttpServer>[0]>,
  run: (baseUrl: string) => Promise<void>,
) {
  const root = await mkdtemp(path.join(tmpdir(), 'relay-http-'));
  const publicDir = path.join(root, 'public');
  const takeDir = path.join(root, 'takes');
  await mkdir(publicDir, { recursive: true });
  await mkdir(takeDir, { recursive: true });
  await writeFile(path.join(publicDir, 'index.html'), '<main id="fixture">Relay fixture</main>');
  await writeFile(path.join(takeDir, TAKE_ID + '.wav'), Buffer.from('RIFFfixture'));

  const server = createRelayHttpServer({
    publicDir,
    takeDir,
    relayKey: null,
    remoteStatus: () => ({ ok: true, state: 'idle' }),
    observationStatusV1: () => ({ version: 1, sequence: 1 }),
    readiness: () => ({ ready: true }),
    ...options,
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    await run('http://127.0.0.1:' + address.port);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await rm(root, { recursive: true, force: true });
  }
}

test('HTTP adapter serves static content and health without Express disclosure', async () => {
  await withHttpServer({}, async (baseUrl) => {
    const root = await fetch(baseUrl + '/');
    assert.equal(root.status, 200);
    assert.match(await root.text(), /Relay fixture/);
    assert.equal(root.headers.get('x-powered-by'), null);

    const health = await fetch(baseUrl + '/healthz');
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
  });
});

test('status and readiness callbacks stay lazy and authoritative in the caller', async () => {
  let sequence = 0;
  await withHttpServer({
    remoteStatus: () => ({ sequence: ++sequence }),
    observationStatusV1: () => ({ version: 1, sequence: ++sequence }),
    readiness: () => ({ ready: sequence >= 2 }),
  }, async (baseUrl) => {
    assert.deepEqual(await (await fetch(baseUrl + '/statusz')).json(), { sequence: 1 });
    assert.deepEqual(await (await fetch(baseUrl + '/api/status/v1')).json(), { version: 1, sequence: 2 });
    const ready = await fetch(baseUrl + '/readyz');
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { ready: true });
  });
});

test('readiness preserves the caller result and maps false to HTTP 503', async () => {
  await withHttpServer({ readiness: () => ({ ready: false }) }, async (baseUrl) => {
    const response = await fetch(baseUrl + '/readyz');
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ready: false });
  });
});

test('Take artifact route keeps UUID fencing, private caching and relay-key auth', async () => {
  await withHttpServer({ relayKey: 'sekrit' }, async (baseUrl) => {
    assert.equal((await fetch(baseUrl + '/takes/not-a-uuid.wav?key=sekrit')).status, 404);
    assert.equal((await fetch(baseUrl + '/takes/' + TAKE_ID + '.wav')).status, 401);

    const response = await fetch(baseUrl + '/takes/' + TAKE_ID + '.wav?key=sekrit');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(Buffer.from(await response.arrayBuffer()).toString(), 'RIFFfixture');
  });
});

test('server delegates only the physical HTTP surface to the adapter', async () => {
  const { readFile } = await import('node:fs/promises');
  const server = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
  const adapter = await readFile(new URL('../src/relay-http-server.ts', import.meta.url), 'utf8');

  assert.ok(server.includes("const server = createRelayHttpServer({"));
  assert.ok(server.includes("remoteStatus: () => remoteStatusPayload(),"));
  assert.ok(server.includes("observationStatusV1: () => observationStatusV1Payload(),"));
  assert.ok(server.includes("readiness: () => readinessPayload(),"));
  for (const forbidden of [
    "import express from",
    "createServer(",
    "TAKE_ARTIFACT_ID_PATTERN",
    "app.get(",
    "app.use(",
    "app.disable(",
  ]) {
    assert.equal(server.includes(forbidden), false);
  }
  assert.ok(adapter.includes("app.get('/statusz'"));
  assert.ok(adapter.includes("app.get('/api/status/v1'"));
  assert.ok(adapter.includes("app.get('/readyz'"));
  for (const moduleName of [
    'audio-session',
    'participant-session',
    'mic-runtime',
    'take-controller',
    'readiness',
    'remote-status',
    'observation-status',
  ]) {
    assert.equal(adapter.includes("from './" + moduleName + ".js'"), false);
  }
  assert.doesNotMatch(adapter, /buildReadiness|deriveRemoteStatusHealth|buildRelayObservationStatusV1/);
});
