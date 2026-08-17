import type { RemoteStatusState } from './remote-status.js';

export type RelayObservationState = RemoteStatusState;
export type RelayTimingMode = 'network-estimate' | 'acoustic-calibration';

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
    timingMode: RelayTimingMode;
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
type RelayObservationStatusV1Input = Omit<RelayObservationStatusV1Body, 'workload' | 'calibration'> & {
  workload: Omit<RelayObservationStatusV1Body['workload'], 'state'> & { state: string };
  calibration: Omit<RelayObservationStatusV1Body['calibration'], 'timingMode'> & { timingMode: string };
};

const OBSERVATION_STATES = new Set<RelayObservationState>(['idle', 'live', 'degraded', 'fault']);
const TIMING_MODES = new Set<RelayTimingMode>(['network-estimate', 'acoustic-calibration']);

function observationState(value: string): RelayObservationState {
  if (OBSERVATION_STATES.has(value as RelayObservationState)) return value as RelayObservationState;
  throw new Error(`Unsupported Relay observation state: ${value}`);
}

function timingMode(value: string): RelayTimingMode {
  if (TIMING_MODES.has(value as RelayTimingMode)) return value as RelayTimingMode;
  throw new Error(`Unsupported Relay timing mode: ${value}`);
}

export function buildRelayObservationStatusV1(
  body: RelayObservationStatusV1Input,
  generatedAt = new Date().toISOString(),
): RelayObservationStatusV1 {
  return {
    schema: 'relay.observation.v1',
    generatedAt,
    ...body,
    workload: {
      ...body.workload,
      state: observationState(body.workload.state),
    },
    calibration: {
      ...body.calibration,
      timingMode: timingMode(body.calibration.timingMode),
    },
  };
}
