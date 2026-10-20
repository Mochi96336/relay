/**
 * The audio-uplink-health report a Mic page sends, with nothing wrong in it:
 * the WebSocket path, no drops, no rejects. A test passes only what its
 * report has to say differently; `droppedSamples` and `transport` are merged
 * field by field, everything else replaces. Without `type`, as several tests
 * hand it straight to the runtime; add `type: 'audio-uplink-health'` to send it.
 */
export function uplinkHealthReport(
  captureGeneration: number,
  capturedSamples: number,
  {
    droppedSamples,
    transport,
    ...fields
  }: Record<string, unknown> & {
    droppedSamples?: Record<string, unknown>;
    transport?: Record<string, unknown>;
  } = {},
) {
  return {
    version: 1,
    captureGeneration,
    capturedSamples,
    inputGapSamples: 0,
    inputMuted: false,
    droppedSamples: { total: 0, disconnected: 0, congested: 0, packetTooLarge: 0, ...droppedSamples },
    controlReconnects: 0,
    transport: {
      path: 'websocket',
      maxPacketBytes: null as number | null,
      minWebTransportMaxPacketBytes: null as number | null,
      maxWebTransportMaxPacketBytes: null as number | null,
      webTransportAttempts: 0,
      webTransportConnections: 0,
      webTransportDemotions: 0,
      webTransportPacketsSubmitted: 0,
      webTransportCongestedRejects: 0,
      webTransportPacketTooLargeRejects: 0,
      webTransportSendFailures: 0,
      webSocketPacketsSent: 0,
      webSocketCongestedRejects: 0,
      webSocketDisconnectedRejects: 0,
      webSocketSendFailures: 0,
      ...transport,
    },
    ...fields,
  };
}
