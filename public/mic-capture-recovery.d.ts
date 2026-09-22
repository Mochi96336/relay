export const DEFAULT_PCM_STALL_MS: number;
export const DEFAULT_HIDDEN_DISCONTINUITY_MS: number;

export type MicCaptureSnapshot = {
  nowMs: number;
  visible?: boolean;
  contextState?: string;
  contextTime: number;
  sampleCursor: number;
  inputMuted?: boolean;
};

export type MicCaptureRecoveryDecision = {
  resume: boolean;
  rebuild: boolean;
  recovered: boolean;
  contextAdvanced?: boolean;
  sampleAdvanced?: boolean;
  stalledForMs?: number;
};

export type MicCaptureInputGapDecision = {
  rebuild: boolean;
  recovered: boolean;
  reason: 'input-gap' | null;
};

export class MicCaptureRecoveryWatchdog {
  constructor(options?: { stallAfterMs?: number; hiddenDiscontinuityMs?: number });
  reset(): void;
  start(snapshot: MicCaptureSnapshot, reason?: string): void;
  stop(): void;
  beginRecovery(snapshot: MicCaptureSnapshot, reason?: string): void;
  noteHidden(snapshot: MicCaptureSnapshot): void;
  noteForeground(snapshot: MicCaptureSnapshot): { discontinuity: boolean; rebuild: boolean };
  noteGraphRebuilt(snapshot: MicCaptureSnapshot): void;
  noteInputGap(
    snapshot: MicCaptureSnapshot,
    options?: { recovered?: boolean },
  ): MicCaptureInputGapDecision;
  status(): {
    active: boolean;
    recovering: boolean;
    recoveryReason: string | null;
    rebuildRequested: boolean;
    rebuildBudgetSpent: boolean;
    inputGapActive: boolean;
  };
  observe(
    snapshot: MicCaptureSnapshot,
    options?: { freshPcm?: boolean },
  ): MicCaptureRecoveryDecision;
}
