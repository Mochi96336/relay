import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LISTENER_INCIDENT_CLIENT_MAX_BYTES,
  createListenerIncidentReport,
  fitListenerIncidentReport,
} from '../public/listener-incident-report.js';

test('listener incident upload fitting keeps recent evidence under the transport budget', () => {
  const snapshots = Array.from({ length: 240 }, (_, index) => ({
    index,
    payload: 's'.repeat(1_600),
  }));
  const events = Array.from({ length: 512 }, (_, index) => ({
    index,
    detail: 'e'.repeat(900),
  }));
  const report = createListenerIncidentReport({
    pathname: '/listen',
    visibilityState: 'visible',
    userAgent: 'test-agent',
    reportedAtUnixMs: 123,
    flight: {
      version: 1,
      generatedAtMs: 456,
      generatedAtUnixMs: 789,
      snapshotCapacity: 240,
      eventCapacity: 512,
      snapshots,
      events,
    },
  });

  const fitted = fitListenerIncidentReport(report);
  assert.ok(fitted.byteLength <= LISTENER_INCIDENT_CLIENT_MAX_BYTES);
  assert.equal((fitted.report.flight.snapshots.at(-1) as { index: number } | undefined)?.index, 239);
  assert.equal((fitted.report.flight.events.at(-1) as { index: number } | undefined)?.index, 511);
  assert.ok(
    fitted.report.flight.snapshots.length < snapshots.length
      || fitted.report.flight.events.length < events.length,
  );
  assert.equal(Buffer.byteLength(fitted.body), fitted.byteLength);
});
