export const DEFAULT_MEDIA_PATH_STALE_OBSERVATIONS: number;
export const DEFAULT_MEDIA_PATH_MIN_PACKET_COVERAGE: number;
export const DEFAULT_MEDIA_PATH_MIN_PACKET_WINDOW: number;

export type MicMediaPathRecoveryAction =
  | 'none'
  | 'demote-webtransport'
  | 'replace-websocket'
  | 'recovered'
  | 'degraded-latched';

export type MicMediaPathRecoveryObservation = {
  captureGeneration: number;
  capturedSamples: number;
  serverAcceptedFrameSerial: number;
  senderSubmittedPackets?: number | null;
  senderFailedPackets?: number | null;
  serverReceivedPacketSerial?: number | null;
  serverReceivedSampleSerial?: number | null;
  localCaptureBacklogDroppedSamples?: number | null;
  serverMediaPath?: 'webtransport' | 'websocket' | null;
  path: 'webtransport' | 'websocket';
  socketEpoch: number;
  eligible?: boolean;
};

export type MicMediaPathRecoveryStatus = {
  captureGeneration: number | null;
  socketEpoch: number | null;
  phase: string;
  staleObservations: number;
  packetCoverage: number | null;
  sampleCoverage: number | null;
  proofBaselineSerial: number | null;
  proofServerWebSocketReady: boolean;
  webTransportDemotionUsed: boolean;
  webSocketReplacementUsed: boolean;
  webTransportQuarantined: boolean;
  degraded: boolean;
};

export type MicMediaPathRecoveryDecision = MicMediaPathRecoveryStatus & {
  action: MicMediaPathRecoveryAction;
  reason: string;
};

export class MicMediaPathRecovery {
  constructor(options?: {
    staleObservations?: number;
    minPacketCoverage?: number;
    minPacketWindow?: number;
  });
  reset(): void;
  status(): MicMediaPathRecoveryStatus;
  quarantineWebTransport(): boolean;
  noteSourceIneligibleBoundary(): void;
  beginGeneration(generation: number): boolean;
  rebaseline(input?: {
    capturedSamples?: number | null;
    serverAcceptedFrameSerial?: number | null;
    socketEpoch?: number | null;
    senderSubmittedPackets?: number | null;
    senderFailedPackets?: number | null;
    serverReceivedPacketSerial?: number | null;
    serverReceivedSampleSerial?: number | null;
    localCaptureBacklogDroppedSamples?: number | null;
  }): void;
  observe(input: MicMediaPathRecoveryObservation): MicMediaPathRecoveryDecision;
}
