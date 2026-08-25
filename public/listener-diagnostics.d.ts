export type ListenerEvidence =
  | 'intentionally-muted'
  | 'audio-interrupted'
  | 'audio-not-running'
  | 'transport-unproven'
  | 'transport-stale'
  | 'render-unproven'
  | 'render-stale'
  | 'playback-starved'
  | 'internally-healthy';

export interface ListenerWorkletHealth {
  playing?: boolean;
  queuedMs?: number;
  targetPrebufferMs?: number;
  jitterTargetMs?: number;
  arrivalJitterMs?: number;
  arrivalDeviationMs?: number;
  underruns?: number;
  droppedMs?: number;
  starvedMs?: number;
  [key: string]: unknown;
}

export interface ListenerEvidenceSnapshot {
  effectiveMuted?: boolean;
  contextState?: string;
  transportEnabled?: boolean;
  lastMonitorFrameAgeMs?: number | null;
  lastWorkletHealthAgeMs?: number | null;
  workletHealth?: ListenerWorkletHealth | null;
  evidence?: ListenerEvidence;
  [key: string]: unknown;
}

export interface ListenerRecordedSnapshot extends ListenerEvidenceSnapshot {
  atMs: number;
  evidence: ListenerEvidence;
}

export interface ListenerRecordedEvent {
  atMs: number;
  type: string;
  detail: Record<string, unknown>;
}

export interface ListenerFlightDump {
  version: 1;
  generatedAtMs: number;
  generatedAtUnixMs: number | null;
  snapshotCapacity: number;
  eventCapacity: number;
  snapshots: ListenerRecordedSnapshot[];
  events: ListenerRecordedEvent[];
}

export function classifyListenerEvidence(
  snapshot?: ListenerEvidenceSnapshot,
  options?: { staleAfterMs?: number },
): ListenerEvidence;

export function createListenerFlightRecorder(options?: {
  snapshotCapacity?: number;
  eventCapacity?: number;
  now?: () => number;
  wallNow?: () => number;
}): {
  recordSnapshot(snapshot?: ListenerEvidenceSnapshot): ListenerRecordedSnapshot;
  recordEvent(type: string, detail?: Record<string, unknown>): ListenerRecordedEvent;
  dump(): ListenerFlightDump;
  clear(): void;
};

export interface ListenerDebugFaultSnapshot {
  dropPcm: boolean;
  dropPcmRemainingMs: number;
  silentOutput: boolean;
  silentOutputRemainingMs: number;
}

export function createListenerDebugFaultState(options?: {
  now?: () => number;
}): {
  dropPcmFor(ms?: number): number;
  silenceOutputFor(ms?: number): number;
  shouldDropPcm(): boolean;
  shouldSilenceOutput(): boolean;
  snapshot(): ListenerDebugFaultSnapshot;
  clear(): void;
};
