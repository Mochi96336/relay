export type AudioCaptureAppliedSettings = {
  echoCancellation: boolean | null;
  noiseSuppression: boolean | null;
  autoGainControl: boolean | null;
  audioSessionType: string | null;
};

export type AudioCaptureLevel = {
  peakDbfs: number;
  rmsDbfs: number;
};

export type AudioCaptureDispatchHealth = {
  lagMs: number;
  maxLagMs: number;
  backlogMs: number;
  backlogActive: boolean;
};

export type AudioUplinkTransportHealth = {
  path: 'websocket' | 'webtransport';
  maxPacketBytes: number | null;
  minWebTransportMaxPacketBytes: number | null;
  maxWebTransportMaxPacketBytes: number | null;
  /** Relay's application packet ceiling after clamping the browser-reported budget. */
  datagramPacketBytesCeiling: number | null;
  /** Relay's bounded local outstanding-write budget, in packets. */
  datagramQueuePackets: number | null;
  /** Browser media recovery exhausted its bounded same-capture actions. Older v1 pages omit it. */
  mediaRecoveryDegraded?: boolean;
  webTransportAttempts: number;
  webTransportConnections: number;
  webTransportDemotions: number;
  webTransportPacketsSubmitted: number;
  webTransportCongestedRejects: number;
  webTransportPacketTooLargeRejects: number;
  webTransportSendFailures: number;
  webSocketPacketsSent: number;
  webSocketCongestedRejects: number;
  webSocketDisconnectedRejects: number;
  webSocketSendFailures: number;
};

export type AudioUplinkHealth = {
  version: 1;
  captureGeneration: number;
  /** Optional browser-generated correlation token. Older v1 pages omit it. */
  healthRequestId?: number;
  capturedSamples: number;
  inputGapSamples: number;
  inputMuted: boolean;
  /**
   * Parser provenance only: false means this v1 snapshot predates explicit
   * source mute telemetry and inputMuted is the legacy compatibility default.
   * The parser defines this property non-enumerably so wire/status shapes stay
   * unchanged. Hand-constructed typed health fixtures may omit it.
   */
  inputMutedObserved?: boolean;
  /** Browser-reported facts about the applied MediaStreamTrack. Diagnostic only. */
  capture: AudioCaptureAppliedSettings | null;
  /** Capture-worklet level before packetization/transport. Diagnostic only. */
  captureLevel: AudioCaptureLevel | null;
  /** Main-thread dispatch freshness for worklet PCM. Diagnostic only. */
  captureDispatch: AudioCaptureDispatchHealth | null;
  droppedSamples: {
    total: number;
    disconnected: number;
    congested: number;
    packetTooLarge: number;
    captureBacklog: number;
  };
  controlReconnects: number;
  transport: AudioUplinkTransportHealth;
};

const MAX_AUDIO_SESSION_TYPE_LENGTH = 64;

function uint32(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= 0xffff_ffff
    ? number >>> 0
    : null;
}

function strictUint32(value: unknown): number | null {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= 0
    && value <= 0xffff_ffff
    ? value >>> 0
    : null;
}

function nonNegativeSafeInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function positiveSafeIntegerOrNull(value: unknown): number | null | undefined {
  if (value === null) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function nullableBoolean(value: unknown): boolean | null | undefined {
  if (value === null) return null;
  return typeof value === 'boolean' ? value : undefined;
}

function nullableAudioSessionType(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_AUDIO_SESSION_TYPE_LENGTH
    ? value
    : undefined;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseCaptureAppliedSettings(value: unknown): AudioCaptureAppliedSettings | null | undefined {
  if (value === null) return null;
  const capture = record(value);
  if (!capture) return undefined;

  const echoCancellation = nullableBoolean(capture.echoCancellation);
  const noiseSuppression = nullableBoolean(capture.noiseSuppression);
  const autoGainControl = nullableBoolean(capture.autoGainControl);
  const audioSessionType = nullableAudioSessionType(capture.audioSessionType);
  if (
    echoCancellation === undefined
    || noiseSuppression === undefined
    || autoGainControl === undefined
    || audioSessionType === undefined
  ) return undefined;

  return { echoCancellation, noiseSuppression, autoGainControl, audioSessionType };
}

function parseCaptureLevel(value: unknown): AudioCaptureLevel | null | undefined {
  if (value === null) return null;
  const level = record(value);
  if (!level) return undefined;

  const peakDbfs = level.peakDbfs;
  const rmsDbfs = level.rmsDbfs;
  if (
    typeof peakDbfs !== 'number'
    || typeof rmsDbfs !== 'number'
    || !Number.isFinite(peakDbfs)
    || !Number.isFinite(rmsDbfs)
    || peakDbfs > 0
    || rmsDbfs > peakDbfs
  ) return undefined;
  return { peakDbfs, rmsDbfs };
}

function parseCaptureDispatch(value: unknown): AudioCaptureDispatchHealth | null | undefined {
  if (value === null) return null;
  const dispatch = record(value);
  if (!dispatch) return undefined;

  const lagMs = nonNegativeSafeInteger(dispatch.lagMs);
  const maxLagMs = nonNegativeSafeInteger(dispatch.maxLagMs);
  const backlogMs = nonNegativeSafeInteger(dispatch.backlogMs);
  const backlogActive = dispatch.backlogActive;
  if (
    lagMs === null
    || maxLagMs === null
    || backlogMs === null
    || backlogMs <= 0
    || typeof backlogActive !== 'boolean'
    || maxLagMs < lagMs
  ) return undefined;

  return { lagMs, maxLagMs, backlogMs, backlogActive };
}

export function parseAudioUplinkHealth(value: unknown): AudioUplinkHealth | null {
  const payload = record(value);
  if (!payload || Number(payload.version) !== 1) return null;

  const captureGeneration = uint32(payload.captureGeneration);
  const healthRequestId = payload.healthRequestId === undefined
    ? undefined
    : strictUint32(payload.healthRequestId);
  const capturedSamples = nonNegativeSafeInteger(payload.capturedSamples);
  const inputGapSamples = nonNegativeSafeInteger(payload.inputGapSamples);
  const controlReconnects = nonNegativeSafeInteger(payload.controlReconnects);
  const inputMuted = payload.inputMuted === undefined ? false : payload.inputMuted;
  const capture = payload.capture === undefined ? null : parseCaptureAppliedSettings(payload.capture);
  const captureLevel = payload.captureLevel === undefined ? null : parseCaptureLevel(payload.captureLevel);
  const captureDispatch = payload.captureDispatch === undefined
    ? null
    : parseCaptureDispatch(payload.captureDispatch);
  const dropped = record(payload.droppedSamples);
  const transport = record(payload.transport);
  if (
    captureGeneration === null
    || healthRequestId === null
    || capturedSamples === null
    || inputGapSamples === null
    || controlReconnects === null
    || typeof inputMuted !== 'boolean'
    || capture === undefined
    || captureLevel === undefined
    || captureDispatch === undefined
    || !dropped
    || !transport
  ) return null;

  const total = nonNegativeSafeInteger(dropped.total);
  const disconnected = nonNegativeSafeInteger(dropped.disconnected);
  const congested = nonNegativeSafeInteger(dropped.congested);
  const packetTooLarge = nonNegativeSafeInteger(dropped.packetTooLarge);
  // Added after v1 shipped. Older pages omit it and therefore contributed zero
  // pre-transport capture-backlog drops to the cumulative total.
  const captureBacklog = dropped.captureBacklog === undefined
    ? 0
    : nonNegativeSafeInteger(dropped.captureBacklog);
  if (
    total === null
    || disconnected === null
    || congested === null
    || packetTooLarge === null
    || captureBacklog === null
    || total !== disconnected + congested + packetTooLarge + captureBacklog
  ) return null;

  const path = transport.path;
  if (path !== 'websocket' && path !== 'webtransport') return null;

  const maxPacketBytes = positiveSafeIntegerOrNull(transport.maxPacketBytes);
  const minWebTransportMaxPacketBytes = positiveSafeIntegerOrNull(transport.minWebTransportMaxPacketBytes);
  const maxWebTransportMaxPacketBytes = positiveSafeIntegerOrNull(transport.maxWebTransportMaxPacketBytes);
  // These fields were added after the original v1 payload. Missing means an
  // older page, not a malformed report; a present invalid value is rejected.
  const datagramPacketBytesCeiling = transport.datagramPacketBytesCeiling === undefined
    ? null
    : positiveSafeIntegerOrNull(transport.datagramPacketBytesCeiling);
  const datagramQueuePackets = transport.datagramQueuePackets === undefined
    ? null
    : positiveSafeIntegerOrNull(transport.datagramQueuePackets);
  // Added after v1 shipped. Older pages omit it and are healthy by default;
  // a supplied non-boolean value is malformed rather than truthy telemetry.
  const mediaRecoveryDegraded = transport.mediaRecoveryDegraded === undefined
    ? false
    : transport.mediaRecoveryDegraded;
  if (
    maxPacketBytes === undefined
    || minWebTransportMaxPacketBytes === undefined
    || maxWebTransportMaxPacketBytes === undefined
    || datagramPacketBytesCeiling === undefined
    || datagramQueuePackets === undefined
    || typeof mediaRecoveryDegraded !== 'boolean'
  ) return null;
  if (
    minWebTransportMaxPacketBytes !== null
    && maxWebTransportMaxPacketBytes !== null
    && minWebTransportMaxPacketBytes > maxWebTransportMaxPacketBytes
  ) return null;

  const counterNames = [
    'webTransportAttempts',
    'webTransportConnections',
    'webTransportDemotions',
    'webTransportPacketsSubmitted',
    'webTransportCongestedRejects',
    'webTransportPacketTooLargeRejects',
    'webTransportSendFailures',
    'webSocketPacketsSent',
    'webSocketCongestedRejects',
    'webSocketDisconnectedRejects',
    'webSocketSendFailures',
  ] as const;
  const counters = Object.fromEntries(
    counterNames.map((name) => [name, nonNegativeSafeInteger(transport[name])]),
  ) as Record<(typeof counterNames)[number], number | null>;
  if (counterNames.some((name) => counters[name] === null)) return null;

  const parsed: AudioUplinkHealth = {
    version: 1,
    captureGeneration,
    ...(healthRequestId === undefined ? {} : { healthRequestId }),
    capturedSamples,
    inputGapSamples,
    inputMuted,
    capture,
    captureLevel,
    captureDispatch,
    droppedSamples: { total, disconnected, congested, packetTooLarge, captureBacklog },
    controlReconnects,
    transport: {
      path,
      maxPacketBytes,
      minWebTransportMaxPacketBytes,
      maxWebTransportMaxPacketBytes,
      datagramPacketBytesCeiling,
      datagramQueuePackets,
      mediaRecoveryDegraded,
      ...counters as Record<(typeof counterNames)[number], number>,
    },
  };
  Object.defineProperty(parsed, 'inputMutedObserved', {
    value: payload.inputMuted !== undefined,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return parsed;
}
