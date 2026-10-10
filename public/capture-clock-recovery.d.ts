export class CaptureClockRecovery {
  constructor();
  reset(): void;
  observe(snapshot: {
    nowMs: number;
    contextTime: number;
    visible: boolean;
    contextState: string;
    inputMuted: boolean;
  }): boolean;
}
