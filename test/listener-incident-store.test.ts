import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ListenerIncidentStore,
  parseListenerIncidentReport,
} from '../src/listener-incident-store.js';

function report(marker = 'baseline') {
  return {
    version: 1,
    reason: 'user-reported-silent',
    reportedAtUnixMs: 123_456,
    page: {
      pathname: '/',
      visibilityState: 'visible',
      userAgent: 'listener-test',
    },
    flight: {
      version: 1,
      generatedAtMs: 42,
      generatedAtUnixMs: 123_456,
      snapshotCapacity: 240,
      eventCapacity: 512,
      snapshots: [{ marker }],
      events: [{ type: 'user-reported-silent' }],
    },
  } as const;
}

test('listener incident parser accepts only the bounded silence-report contract', () => {
  assert.equal(parseListenerIncidentReport(null), null);
  assert.equal(parseListenerIncidentReport({ version: 2 }), null);
  assert.equal(parseListenerIncidentReport({ ...report(), reason: 'other' }), null);

  const oversized = report();
  const parsed = parseListenerIncidentReport({
    ...oversized,
    page: {
      pathname: 'x'.repeat(1_000),
      visibilityState: 'v'.repeat(100),
      userAgent: 'u'.repeat(2_000),
    },
    flight: {
      ...oversized.flight,
      snapshotCapacity: 999,
      eventCapacity: 999,
      snapshots: Array.from({ length: 300 }, (_, index) => ({ index })),
      events: Array.from({ length: 600 }, (_, index) => ({ index })),
    },
  });

  assert.ok(parsed);
  assert.equal(parsed.page.pathname.length, 512);
  assert.equal(parsed.page.visibilityState.length, 32);
  assert.equal(parsed.page.userAgent.length, 1_024);
  assert.equal(parsed.flight.snapshotCapacity, 240);
  assert.equal(parsed.flight.eventCapacity, 512);
  assert.equal(parsed.flight.snapshots.length, 240);
  assert.equal(parsed.flight.events.length, 512);
  assert.deepEqual(parsed.flight.snapshots[0], { index: 60 });
  assert.deepEqual(parsed.flight.events[0], { index: 88 });
});

test('listener incident store persists reports and prunes the oldest files', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-listener-incidents-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });

  const store = new ListenerIncidentStore(directory, 2);
  const first = parseListenerIncidentReport(report('first'));
  const second = parseListenerIncidentReport(report('second'));
  const third = parseListenerIncidentReport(report('third'));
  assert.ok(first && second && third);

  await store.write(first);
  await new Promise((resolve) => setTimeout(resolve, 2));
  await store.write(second);
  await new Promise((resolve) => setTimeout(resolve, 2));
  const storedThird = await store.write(third);

  const files = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
  assert.equal(files.length, 2);
  assert.equal(files.some((name) => name.includes(storedThird.incidentId)), true);

  const payloads = await Promise.all(files.map(async (name) => (
    JSON.parse(await readFile(path.join(directory, name), 'utf8'))
  )));
  assert.equal(payloads.some((entry) => entry.report.flight.snapshots[0].marker === 'first'), false);
  assert.equal(payloads.some((entry) => entry.report.flight.snapshots[0].marker === 'second'), true);
  assert.equal(payloads.some((entry) => entry.report.flight.snapshots[0].marker === 'third'), true);
});
