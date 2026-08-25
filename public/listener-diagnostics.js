const DEFAULT_SNAPSHOT_CAPACITY = 240;
const DEFAULT_EVENT_CAPACITY = 512;
const DEFAULT_STALE_AFTER_MS = 1_500;

function defaultNow() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function defaultWallNow() {
  return Date.now();
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clampCapacity(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function jsonSafe(value, depth = 0) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (depth >= 5) return String(value);
  if (Array.isArray(value)) return value.slice(0, 32).map((entry) => jsonSafe(entry, depth + 1));
  if (typeof value === 'object') {
    const result = {};
    for (const [key, entry] of Object.entries(value).slice(0, 64)) {
      result[key] = jsonSafe(entry, depth + 1);
    }
    return result;
  }
  return String(value);
}

function pushBounded(items, value, capacity) {
  items.push(value);
  const overflow = items.length - capacity;
  if (overflow > 0) items.splice(0, overflow);
}

export function classifyListenerEvidence(snapshot = {}, { staleAfterMs = DEFAULT_STALE_AFTER_MS } = {}) {
  const staleThresholdMs = Math.max(1, finiteOrNull(staleAfterMs) ?? DEFAULT_STALE_AFTER_MS);
  if (snapshot.effectiveMuted === true) return 'intentionally-muted';

  const contextState = String(snapshot.contextState ?? 'closed');
  if (contextState === 'suspended' || contextState === 'interrupted') return 'audio-interrupted';
  if (contextState !== 'running') return 'audio-not-running';

  if (snapshot.transportEnabled === true) {
    const monitorAgeMs = finiteOrNull(snapshot.lastMonitorFrameAgeMs);
    if (monitorAgeMs === null) return 'transport-unproven';
    if (monitorAgeMs >= staleThresholdMs) return 'transport-stale';
  }

  const workletAgeMs = finiteOrNull(snapshot.lastWorkletHealthAgeMs);
  if (workletAgeMs === null) return 'render-unproven';
  if (workletAgeMs >= staleThresholdMs) return 'render-stale';

  if (
    snapshot.workletHealth?.playing === false
    && (finiteOrNull(snapshot.workletHealth?.starvedMs) ?? 0) > 0
  ) {
    return 'playback-starved';
  }

  return 'internally-healthy';
}

export function createListenerFlightRecorder({
  snapshotCapacity = DEFAULT_SNAPSHOT_CAPACITY,
  eventCapacity = DEFAULT_EVENT_CAPACITY,
  now = defaultNow,
  wallNow = defaultWallNow,
} = {}) {
  const snapshots = [];
  const events = [];
  const maxSnapshots = clampCapacity(snapshotCapacity, DEFAULT_SNAPSHOT_CAPACITY);
  const maxEvents = clampCapacity(eventCapacity, DEFAULT_EVENT_CAPACITY);

  function atMs() {
    return finiteOrNull(now()) ?? defaultNow();
  }

  function recordSnapshot(snapshot = {}) {
    const safe = jsonSafe(snapshot);
    const entry = {
      atMs: atMs(),
      ...safe,
    };
    if (!entry.evidence) entry.evidence = classifyListenerEvidence(entry);
    pushBounded(snapshots, entry, maxSnapshots);
    return entry;
  }

  function recordEvent(type, detail = {}) {
    const entry = {
      atMs: atMs(),
      type: String(type || 'unknown'),
      detail: jsonSafe(detail),
    };
    pushBounded(events, entry, maxEvents);
    return entry;
  }

  function dump() {
    return {
      version: 1,
      generatedAtMs: atMs(),
      generatedAtUnixMs: finiteOrNull(wallNow()),
      snapshotCapacity: maxSnapshots,
      eventCapacity: maxEvents,
      snapshots: snapshots.map((entry) => jsonSafe(entry)),
      events: events.map((entry) => jsonSafe(entry)),
    };
  }

  function clear() {
    snapshots.length = 0;
    events.length = 0;
  }

  return {
    recordSnapshot,
    recordEvent,
    dump,
    clear,
  };
}

export function createListenerDebugFaultState({ now = defaultNow } = {}) {
  let dropPcmUntilMs = 0;
  let silentOutputUntilMs = 0;

  function readNow() {
    return finiteOrNull(now()) ?? defaultNow();
  }

  function duration(value, fallbackMs) {
    const number = finiteOrNull(value);
    return Math.max(1, number ?? fallbackMs);
  }

  function dropPcmFor(ms = 3_000) {
    dropPcmUntilMs = Math.max(dropPcmUntilMs, readNow() + duration(ms, 3_000));
    return dropPcmUntilMs;
  }

  function silenceOutputFor(ms = 3_000) {
    silentOutputUntilMs = Math.max(silentOutputUntilMs, readNow() + duration(ms, 3_000));
    return silentOutputUntilMs;
  }

  function shouldDropPcm() {
    return readNow() < dropPcmUntilMs;
  }

  function shouldSilenceOutput() {
    return readNow() < silentOutputUntilMs;
  }

  function snapshot() {
    const current = readNow();
    return {
      dropPcm: current < dropPcmUntilMs,
      dropPcmRemainingMs: Math.max(0, dropPcmUntilMs - current),
      silentOutput: current < silentOutputUntilMs,
      silentOutputRemainingMs: Math.max(0, silentOutputUntilMs - current),
    };
  }

  function clear() {
    dropPcmUntilMs = 0;
    silentOutputUntilMs = 0;
  }

  return {
    dropPcmFor,
    silenceOutputFor,
    shouldDropPcm,
    shouldSilenceOutput,
    snapshot,
    clear,
  };
}
