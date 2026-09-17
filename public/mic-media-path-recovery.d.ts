export const DEFAULT_MEDIA_PATH_STALE_OBSERVATIONS: number;

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
  constructor(options?: { staleObservations?: number });
  reset(): void;
  status(): MicMediaPathRecoveryStatus;
  quarantineWebTransport(): boolean;
  beginGeneration(generation: number): boolean;
  rebaseline(input?: {
    capturedSamples?: number | null;
    serverAcceptedFrameSerial?: number | null;
    socketEpoch?: number | null;
  }): void;
  observe(input: MicMediaPathRecoveryObservation): MicMediaPathRecoveryDecision;
}
