import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { startRelay } from './helpers/harness.js';

function report() {
  return {
    version: 1,
    reason: 'user-reported-silent',
    reportedAtUnixMs: Date.now(),
    page: {
      pathname: '/',
      visibilityState: 'visible',
      userAgent: 'listener-incident-server-test',
    },
    flight: {
      version: 1,
      generatedAtMs: 42,
      generatedAtUnixMs: Date.now(),
      snapshotCapacity: 240,
      eventCapacity: 512,
      snapshots: [{
        contextState: 'running',
        monitorSocketState: 'open',
        lastMonitorFrameAgeMs: 10,
        lastWorkletHealthAgeMs: 10,
        evidence: 'internally-healthy',
      }],
      events: [{ type: 'user-reported-silent' }],
    },
  };
}

async function post(serverUrl: string, body: unknown) {
  return fetch(serverUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('listener incident endpoint is absent unless explicitly enabled', async (t) => {
  const server = await startRelay();
  t.after(() => server.stop());

  const response = await post(
    server.httpUrl('/api/debug/listener-incidents?audioDebug=1'),
    report(),
  );
  assert.equal(response.status, 404);
});

test('listener incident endpoint requires debug intent and Relay key, then persists a bounded report', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-listener-incident-server-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });

  const server = await startRelay({
    RELAY_LISTENER_INCIDENTS: '1',
    RELAY_LISTENER_INCIDENT_DIR: directory,
    RELAY_LISTENER_INCIDENT_MAX_FILES: '5',
    RELAY_KEY: 'incident-test-key',
  });
  t.after(() => server.stop());

  const hidden = await post(
    server.httpUrl('/api/debug/listener-incidents?key=incident-test-key'),
    report(),
  );
  assert.equal(hidden.status, 404);

  const unauthorized = await post(
    server.httpUrl('/api/debug/listener-incidents?audioDebug=1'),
    report(),
  );
  assert.equal(unauthorized.status, 401);

  const invalid = await post(
    server.httpUrl('/api/debug/listener-incidents?audioDebug=1&key=incident-test-key'),
    { version: 1, reason: 'not-silence' },
  );
  assert.equal(invalid.status, 400);

  const accepted = await post(
    server.httpUrl('/api/debug/listener-incidents?audioDebug=1&key=incident-test-key'),
    report(),
  );
  assert.equal(accepted.status, 201);
  const response = await accepted.json() as { ok?: boolean; incidentId?: string };
  assert.equal(response.ok, true);
  assert.match(response.incidentId ?? '', /^\d+-[0-9a-f-]+$/i);

  const files = (await readdir(directory)).filter((name) => name.endsWith('.json'));
  assert.equal(files.length, 1);
  assert.equal(files[0], `${response.incidentId}.json`);

  const stored = JSON.parse(await readFile(path.join(directory, files[0]), 'utf8'));
  assert.equal(stored.incidentId, response.incidentId);
  assert.equal(stored.report.reason, 'user-reported-silent');
  assert.equal(stored.report.page.pathname, '/');
  assert.equal(stored.report.flight.snapshots[0].evidence, 'internally-healthy');
  assert.equal(JSON.stringify(stored).includes('incident-test-key'), false);
});
