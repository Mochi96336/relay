import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { startRelay } from './helpers/harness.js';

function validReport() {
  return {
    version: 1,
    reason: 'user-reported-silent',
    reportedAtUnixMs: Date.now(),
    page: {
      pathname: '/',
      visibilityState: 'visible',
      userAgent: 'listener-test',
    },
    flight: {
      version: 1,
      generatedAtMs: 10,
      generatedAtUnixMs: Date.now(),
      snapshotCapacity: 240,
      eventCapacity: 512,
      snapshots: [{ evidence: 'internally-healthy' }],
      events: [{ type: 'user-reported-silent' }],
    },
  };
}

test('listener incident endpoint is opt-in, authenticated with Relay, bounded and persistent', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-listener-incident-http-'));
  const disabled = await startRelay({ RELAY_LISTENER_INCIDENT_DIR: directory });
  try {
    const response = await fetch(disabled.httpUrl('/api/debug/listener-incidents?audioDebug=1'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validReport()),
    });
    assert.equal(response.status, 404);
  } finally {
    await disabled.stop();
  }

  const server = await startRelay({
    RELAY_LISTENER_INCIDENTS: '1',
    RELAY_LISTENER_INCIDENT_DIR: directory,
    RELAY_LISTENER_INCIDENT_MAX_FILES: '2',
    RELAY_KEY: 'listener-secret',
  });
  try {
    const endpoint = '/api/debug/listener-incidents';
    assert.equal((await fetch(server.httpUrl(`${endpoint}?audioDebug=1`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validReport()),
    })).status, 401);

    assert.equal((await fetch(server.httpUrl(`${endpoint}?key=listener-secret`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validReport()),
    })).status, 404);

    assert.equal((await fetch(server.httpUrl(`${endpoint}?audioDebug=1&key=listener-secret`), {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify(validReport()),
    })).status, 415);

    const accepted = await fetch(server.httpUrl(`${endpoint}?audioDebug=1&key=listener-secret`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validReport()),
    });
    assert.equal(accepted.status, 201);
    const acceptedBody = await accepted.json() as { ok: boolean; incidentId: string };
    assert.equal(acceptedBody.ok, true);
    assert.match(acceptedBody.incidentId, /^[0-9]+-[0-9a-f-]+$/i);

    const oversized: any = validReport();
    oversized.flight.events = [{ type: 'huge', detail: 'x'.repeat(540 * 1024) }];
    const rejected = await fetch(server.httpUrl(`${endpoint}?audioDebug=1&key=listener-secret`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(oversized),
    });
    assert.equal(rejected.status, 413);

    const files = (await readdir(directory)).filter((name) => name.endsWith('.json'));
    assert.equal(files.length, 1);
    const stored = JSON.parse(await readFile(path.join(directory, files[0]), 'utf8'));
    assert.equal(stored.report.reason, 'user-reported-silent');
    assert.equal(stored.report.flight.snapshots[0].evidence, 'internally-healthy');
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
