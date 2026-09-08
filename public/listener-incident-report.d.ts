export const LISTENER_INCIDENT_CLIENT_MAX_BYTES: number;

export type ListenerIncidentFlight = {
  version: number;
  generatedAtMs: number;
  generatedAtUnixMs: number | null;
  snapshotCapacity: number;
  eventCapacity: number;
  snapshots: unknown[];
  events: unknown[];
};

export type ListenerIncidentReport = {
  version: 1;
  reason: 'user-reported-silent';
  reportedAtUnixMs: number;
  page: {
    pathname: string;
    visibilityState: string;
    userAgent: string;
  };
  flight: ListenerIncidentFlight;
};

export function createListenerIncidentReport(input: {
  flight: ListenerIncidentFlight;
  pathname?: string;
  visibilityState?: string;
  userAgent?: string;
  reportedAtUnixMs?: number;
}): ListenerIncidentReport;

export function fitListenerIncidentReport(
  report: ListenerIncidentReport,
  maxBytes?: number,
): { report: ListenerIncidentReport; body: string; byteLength: number };
