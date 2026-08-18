export const MONITOR_PCM_PACKET_VERSION: 1;

export type MonitorPcmFrame = {
  generation: number;
  firstSampleIndex: number;
  sampleCount: number;
  pcm: ArrayBuffer;
};

export type MonitorPcmAccept = {
  action: 'accept';
  reset: boolean;
  reason: 'first' | 'contiguous' | 'gap' | 'generation';
  gapSamples: number;
};

export type MonitorPcmDrop = {
  action: 'drop';
  reason: 'malformed' | 'stale';
  expectedSampleIndex?: number;
};

export type MonitorPcmContinuityDecision = MonitorPcmAccept | MonitorPcmDrop;
export type MonitorPcmReceiveDecision =
  | (MonitorPcmAccept & { frame: MonitorPcmFrame })
  | (MonitorPcmDrop & { frame?: MonitorPcmFrame });

export function decodeMonitorPcmFrame(buffer: ArrayBuffer): MonitorPcmFrame | null;

export function createMonitorPcmContinuity(): {
  reset(): void;
  accept(frame: MonitorPcmFrame): MonitorPcmContinuityDecision;
  snapshot(): {
    generation: number | null;
    expectedSampleIndex: number | null;
  };
};

export function createMonitorPcmReceiver(): {
  reset(): void;
  receive(buffer: ArrayBuffer): MonitorPcmReceiveDecision;
  snapshot(): {
    generation: number | null;
    expectedSampleIndex: number | null;
  };
};
