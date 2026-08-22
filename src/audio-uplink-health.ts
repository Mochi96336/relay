export type AudioUplinkTransportHealth = {
  path: 'websocket' | 'webtransport';
  maxPacketBytes: number | null;
  minWebTransportMaxPacketBytes: number | null;
  maxWebTransportMaxPacketBytes: number | null;
  /** What the page packetized to, which is the browser's claim after clamping. */
  datagramPacketBytesCeiling: number | null;
  /** Outgoing queue depth the platform actually accepted, not the one asked for. */
  datagramQueuePackets: number | null;
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

/**
 * What the phone's capture actually applied, which can differ from what was
 * requested. Echo cancellation removes this device's own speaker from its own
 * microphone, and that is precisely the path both calibration methods measure.
 */
export type AudioUplinkCaptureSettings = {
  echoCancellation: boolean | null;
  noiseSuppression: boolean | null;
  autoGainControl: boolean | null;
  audioSessionType: string | null;
};

/** The capture worklet's own level, measured before packetization. */
export type AudioUplinkCaptureLevel = {
  peakDbfs: number;
  rmsDbfs: number;
};

export type AudioUplinkHealth = {
  version: 1;
  captureGeneration: number;
  capturedSamples: number;
  inputGapSamples: number;
  inputMuted: boolean;
  droppedSamples: {
    total: number;
    disconnected: number;
    congested: number;
    packetTooLarge: number;
  };
  controlReconnects: number;
  capture: AudioUplinkCaptureSettings | null;
  captureLevel: AudioUplinkCaptureLevel | null;
  transport: AudioUplinkTransportHealth;
};

function uint32(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= 0xffff_ffff
    ? number >>> 0
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

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function parseAudioUplinkHealth(value: unknown): AudioUplinkHealth | null {
  const payload = record(value);
  if (!payload || Number(payload.version) !== 1) return null;

  const captureGeneration = uint32(payload.captureGeneration);
  const capturedSamples = nonNegativeSafeInteger(payload.capturedSamples);
  const inputGapSamples = nonNegativeSafeInteger(payload.inputGapSamples);
  const controlReconnects = nonNegativeSafeInteger(payload.controlReconnects);
  const dropped = record(payload.droppedSamples);
  const transport = record(payload.transport);
  if (
    captureGeneration === null
    || capturedSamples === null
    || inputGapSamples === null
    || controlReconnects === null
    || !dropped
    || !transport
  ) return null;

  const total = nonNegativeSafeInteger(dropped.total);
  const disconnected = nonNegativeSafeInteger(dropped.disconnected);
  const congested = nonNegativeSafeInteger(dropped.congested);
  const packetTooLarge = nonNegativeSafeInteger(dropped.packetTooLarge);
  if (
    total === null
    || disconnected === null
    || congested === null
    || packetTooLarge === null
    || total !== disconnected + congested + packetTooLarge
  ) return null;

  // Absent means an older page or a browser that reports nothing, not a broken
  // payload; a present but non-object value is a real malformation.
  const rawCapture = payload.capture;
  let capture: AudioUplinkCaptureSettings | null = null;
  if (rawCapture !== undefined && rawCapture !== null) {
    const settings = record(rawCapture);
    if (settings === null) return null;
    const flag = (value: unknown) => (typeof value === 'boolean' ? value : null);
    const sessionType = settings.audioSessionType;
    if (sessionType !== undefined && sessionType !== null && typeof sessionType !== 'string') {
      return null;
    }
    capture = {
      echoCancellation: flag(settings.echoCancellation),
      noiseSuppression: flag(settings.noiseSuppression),
      autoGainControl: flag(settings.autoGainControl),
      audioSessionType: typeof sessionType === 'string' ? sessionType : null,
    };
  }

  const rawLevel = payload.captureLevel;
  let captureLevel: AudioUplinkCaptureLevel | null = null;
  if (rawLevel !== undefined && rawLevel !== null) {
    const level = record(rawLevel);
    if (level === null) return null;
    const peakDbfs = Number(level.peakDbfs);
    const rmsDbfs = Number(level.rmsDbfs);
    // dBFS is at or below zero, and silence reports as a large negative rather
    // than as -Infinity, so anything outside that is a malformed report.
    if (
      !Number.isFinite(peakDbfs) || !Number.isFinite(rmsDbfs)
      || peakDbfs > 0 || rmsDbfs > 0 || rmsDbfs > peakDbfs
    ) return null;
    captureLevel = { peakDbfs, rmsDbfs };
  }

  const path = transport.path;
  if (path !== 'websocket' && path !== 'webtransport') return null;

  const maxPacketBytes = positiveSafeIntegerOrNull(transport.maxPacketBytes);
  const minWebTransportMaxPacketBytes = positiveSafeIntegerOrNull(transport.minWebTransportMaxPacketBytes);
  const maxWebTransportMaxPacketBytes = positiveSafeIntegerOrNull(transport.maxWebTransportMaxPacketBytes);
  // A capture that predates this field is not a malformed report. Absent means
  // unknown, so an older page keeps delivering the rest of its uplink evidence;
  // a present but nonsensical value is still rejected with the whole payload.
  const datagramPacketBytesCeiling = transport.datagramPacketBytesCeiling === undefined
    ? null
    : positiveSafeIntegerOrNull(transport.datagramPacketBytesCeiling);
  const datagramQueuePackets = transport.datagramQueuePackets === undefined
    ? null
    : positiveSafeIntegerOrNull(transport.datagramQueuePackets);
  if (
    maxPacketBytes === undefined
    || minWebTransportMaxPacketBytes === undefined
    || maxWebTransportMaxPacketBytes === undefined
    || datagramPacketBytesCeiling === undefined
    || datagramQueuePackets === undefined
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

  return {
    version: 1,
    captureGeneration,
    capturedSamples,
    inputGapSamples,
    inputMuted: payload.inputMuted === true,
    droppedSamples: { total, disconnected, congested, packetTooLarge },
    controlReconnects,
    capture,
    captureLevel,
    transport: {
      path,
      maxPacketBytes,
      minWebTransportMaxPacketBytes,
      maxWebTransportMaxPacketBytes,
      datagramPacketBytesCeiling,
      datagramQueuePackets,
      ...counters as Record<(typeof counterNames)[number], number>,
    },
  };
}
