export const LISTENER_INCIDENT_CLIENT_MAX_BYTES = 480 * 1024;

function encodedBytes(value) {
  return new TextEncoder().encode(value).byteLength;
}

function serialize(report) {
  const body = JSON.stringify(report);
  return { body, byteLength: encodedBytes(body) };
}

export function createListenerIncidentReport({
  flight,
  pathname = globalThis.location?.pathname ?? '/',
  visibilityState = globalThis.document?.visibilityState ?? 'unknown',
  userAgent = globalThis.navigator?.userAgent ?? '',
  reportedAtUnixMs = Date.now(),
}) {
  return {
    version: 1,
    reason: 'user-reported-silent',
    reportedAtUnixMs,
    page: {
      pathname: String(pathname),
      visibilityState: String(visibilityState),
      userAgent: String(userAgent),
    },
    flight: {
      ...flight,
      snapshots: Array.isArray(flight?.snapshots) ? [...flight.snapshots] : [],
      events: Array.isArray(flight?.events) ? [...flight.events] : [],
    },
  };
}

/**
 * Fits a report below the transport budget by dropping only the oldest
 * bounded-flight entries. Recent incident evidence always survives.
 */
export function fitListenerIncidentReport(
  report,
  maxBytes = LISTENER_INCIDENT_CLIENT_MAX_BYTES,
) {
  const limit = Math.max(1024, Number(maxBytes) || LISTENER_INCIDENT_CLIENT_MAX_BYTES);
  const fitted = createListenerIncidentReport({
    flight: report.flight,
    pathname: report.page?.pathname,
    visibilityState: report.page?.visibilityState,
    userAgent: report.page?.userAgent,
    reportedAtUnixMs: report.reportedAtUnixMs,
  });

  let serialized = serialize(fitted);
  while (serialized.byteLength > limit) {
    const snapshots = fitted.flight.snapshots;
    const events = fitted.flight.events;
    if (snapshots.length <= 1 && events.length <= 1) {
      throw new Error('Listener incident report cannot fit the upload budget.');
    }

    const oldestSnapshotBytes = snapshots.length > 1
      ? encodedBytes(JSON.stringify(snapshots[0]))
      : -1;
    const oldestEventBytes = events.length > 1
      ? encodedBytes(JSON.stringify(events[0]))
      : -1;
    if (oldestSnapshotBytes >= oldestEventBytes && snapshots.length > 1) snapshots.shift();
    else if (events.length > 1) events.shift();
    else snapshots.shift();
    serialized = serialize(fitted);
  }

  return { ...serialized, report: fitted };
}
