export type RelayObservationState = 'idle' | 'live' | 'degraded' | 'fault';

export type RelayObservationStatusV1 = {
  schema: 'relay.observation.v1';
  generatedAt: string;
  workload: {
    id: 'relay';
    state: RelayObservationState;
    ok: boolean;
    uptimeMs: number;
  };
  activity: {
    sessionActive: boolean;
    participants: {
      total: number;
      connected: number;
    };
    microphoneLease: {
      held: boolean;
      transportConnected: boolean;
    };
  };
  sources: {
    backing: {
      connected: boolean;
      streaming: boolean;
      sampleRate: number | null;
      robot: boolean;
      frameAgeMs: number | null;
    };
    microphone: {
      connected: boolean;
      streaming: boolean;
      sampleRate: number | null;
      frameAgeMs: number | null;
    };
    robot: {
      routeActive: boolean;
      sourceConnected: boolean;
      playerDeltaFresh: boolean;
    };
  };
  calibration: {
    kind: 'none' | 'content' | 'boot-probe';
    stale: boolean;
    timingMode: 'network-estimate' | 'acoustic-calibration';
    activeCalibratedMicLagMs: number | null;
  };
  mix: {
    active: boolean;
    micStarvedFrames: number;
    backingStarvedFrames: number;
    micHeadroomMs: number;
    backingHeadroomMs: number;
    micGapMs: number;
    backingGapMs: number;
    clippedSamples: number;
    limitedSamples: number;
    micPeakDbfs: number | null;
    micRmsDbfs: number | null;
    unheadered: boolean;
    monitorDroppedFrames: number;
  };
  issues: {
    faults: string[];
    warnings: string[];
  };
};

type RelayObservationStatusV1Body = Omit<RelayObservationStatusV1, 'schema' | 'generatedAt'>;

export function buildRelayObservationStatusV1(
  body: RelayObservationStatusV1Body,
  generatedAt = new Date().toISOString(),
): RelayObservationStatusV1 {
  return {
    schema: 'relay.observation.v1',
    generatedAt,
    ...body,
  };
}
