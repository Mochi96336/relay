export type AudioUplinkTransportHealth = {
  path: 'websocket' | 'webtransport';
  maxPacketBytes: number | null;
  minWebTransportMaxPacketBytes: number | null;
  maxWebTransportMaxPacketBytes: number | null;
  /** Relay's application packet ceiling after clamping the browser-reported budget. */
  datagramPacketBytesCeiling: number | null;
  /** Relay's bounded local outstanding-write budget, in packets. */
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
