import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const LISTENER_INCIDENT_VERSION = 1 as const;

export type ListenerIncidentReport = {
  version: typeof LISTENER_INCIDENT_VERSION;
  reason: 'user-reported-silent';
  reportedAtUnixMs: number | null;
  page: {
    pathname: string;
    visibilityState: string;
    userAgent: string;
  };
  flight: {
    version: 1;
    generatedAtMs: number;
    generatedAtUnixMs: number | null;
    snapshotCapacity: number;
    eventCapacity: number;
    snapshots: unknown[];
    events: unknown[];
  };
};

export type StoredListenerIncident = {
  incidentId: string;
  receivedAtUnixMs: number;
  report: ListenerIncidentReport;
};

function finiteOrNull(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function boundedString(value: unknown, maxLength: number): string {
  return String(value ?? '').slice(0, maxLength);
}

function boundedArray(value: unknown, maxLength: number): unknown[] {
  return Array.isArray(value) ? value.slice(-maxLength) : [];
}

export function parseListenerIncidentReport(input: unknown): ListenerIncidentReport | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Record<string, unknown>;
  if (value.version !== LISTENER_INCIDENT_VERSION) return null;
  if (value.reason !== 'user-reported-silent') return null;

  const rawPage = value.page && typeof value.page === 'object'
    ? value.page as Record<string, unknown>
    : {};
  const rawFlight = value.flight && typeof value.flight === 'object'
    ? value.flight as Record<string, unknown>
    : null;
  if (!rawFlight || rawFlight.version !== 1) return null;

  const generatedAtMs = finiteOrNull(rawFlight.generatedAtMs);
  if (generatedAtMs === null) return null;

  const snapshotCapacity = Math.max(1, Math.min(240, Math.trunc(finiteOrNull(rawFlight.snapshotCapacity) ?? 240)));
  const eventCapacity = Math.max(1, Math.min(512, Math.trunc(finiteOrNull(rawFlight.eventCapacity) ?? 512)));

  return {
    version: LISTENER_INCIDENT_VERSION,
    reason: 'user-reported-silent',
    reportedAtUnixMs: finiteOrNull(value.reportedAtUnixMs),
    page: {
      pathname: boundedString(rawPage.pathname, 512),
      visibilityState: boundedString(rawPage.visibilityState, 32),
      userAgent: boundedString(rawPage.userAgent, 1_024),
    },
    flight: {
      version: 1,
      generatedAtMs,
      generatedAtUnixMs: finiteOrNull(rawFlight.generatedAtUnixMs),
      snapshotCapacity,
      eventCapacity,
      snapshots: boundedArray(rawFlight.snapshots, snapshotCapacity),
      events: boundedArray(rawFlight.events, eventCapacity),
    },
  };
}

export class ListenerIncidentStore {
  constructor(
    private readonly directory: string,
    private readonly maxFiles = 100,
  ) {}

  async write(report: ListenerIncidentReport): Promise<StoredListenerIncident> {
    await mkdir(this.directory, { recursive: true });

    const receivedAtUnixMs = Date.now();
    const incidentId = `${receivedAtUnixMs}-${randomUUID()}`;
    const stored: StoredListenerIncident = {
      incidentId,
      receivedAtUnixMs,
      report,
    };
    const filePath = path.join(this.directory, `${incidentId}.json`);
    await writeFile(filePath, `${JSON.stringify(stored, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await this.prune();
    return stored;
  }

  private async prune() {
    const entries = (await readdir(this.directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort();
    const excess = entries.length - Math.max(1, this.maxFiles);
    if (excess <= 0) return;
    await Promise.all(entries.slice(0, excess).map((name) => rm(path.join(this.directory, name), { force: true })));
  }
}
