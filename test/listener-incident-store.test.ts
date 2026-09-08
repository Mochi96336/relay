import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ListenerIncidentStore,
  parseListenerIncidentReport,
} from '../src/listener-incident-store.js';

function report(index: number) {
  return parseListenerIncidentReport({
    version: 1,
    reason: 'user-reported-silent',
    reportedAtUnixMs: 100 + index,
    page: {
      pathname: '/listen',
      visibilityState: 'visible',
      userAgent: 'x'.repeat(2_000),
    },
    flight: {
      version: 1,
      generatedAtMs: index,
      generatedAtUnixMs: 200 + index,
      snapshotCapacity: 999,
      eventCapacity: 999,
      snapshots: Array.from({ length: 300 }, (_, item) => ({ item })),
      events: Array.from({ length: 600 }, (_, item) => ({ item })),
    },
  });
}

test('listener incident parser bounds retained metadata and rejects invalid versions', () => {
  assert.equal(parseListenerIncidentReport({ version: 2 }), null);
  const parsed = report(1);
  assert.ok(parsed);
  assert.equal(parsed.page.userAgent.length, 1_024);
  assert.equal(parsed.flight.snapshotCapacity, 240);
  assert.equal(parsed.flight.eventCapacity, 512);
  assert.equal(parsed.flight.snapshots.length, 240);
  assert.equal(parsed.flight.events.length, 512);
  assert.deepEqual(parsed.flight.snapshots[0], { item: 60 });
  assert.deepEqual(parsed.flight.events[0], { item: 88 });
});

test('listener incident store retains only the newest bounded files', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-listener-incidents-'));
  try {
    const store = new ListenerIncidentStore(directory, 2);
    for (let index = 0; index < 3; index += 1) {
      const parsed = report(index);
      assert.ok(parsed);
      await store.write(parsed);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const files = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
    assert.equal(files.length, 2);
    const newest = JSON.parse(await readFile(path.join(directory, files.at(-1)!), 'utf8'));
    assert.equal(newest.report.reportedAtUnixMs, 102);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
