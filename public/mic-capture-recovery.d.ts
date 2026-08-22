export const DEFAULT_PCM_STALL_MS: number;
export const DEFAULT_HIDDEN_DISCONTINUITY_MS: number;

export type MicCaptureSnapshot = {
  nowMs: number;
  visible?: boolean;
  contextState?: string;
  contextTime: number;
  sampleCursor: number;
};

export type MicCaptureRecoveryDecision = {
  resume: boolean;
  rebuild: boolean;
  recovered: boolean;
  contextAdvanced?: boolean;
  sampleAdvanced?: boolean;
  stalledForMs?: number;
};

export class MicCaptureRecoveryWatchdog {
  constructor(options?: { stallAfterMs?: number; hiddenDiscontinuityMs?: number });
  reset(): void;
  start(snapshot: MicCaptureSnapshot, reason?: string): void;
  stop(): void;
  beginRecovery(snapshot: MicCaptureSnapshot, reason?: string): void;
  noteHidden(snapshot: MicCaptureSnapshot): void;
  noteForeground(snapshot: MicCaptureSnapshot): { discontinuity: boolean };
  noteGraphRebuilt(snapshot: MicCaptureSnapshot): void;
  rearmRebuild(): void;
  status(): {
    active: boolean;
    recovering: boolean;
    recoveryReason: string | null;
    rebuildRequested: boolean;
  };
  observe(
    snapshot: MicCaptureSnapshot,
    options?: { freshPcm?: boolean },
  ): MicCaptureRecoveryDecision;
}
