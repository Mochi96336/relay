type Capture = { context: AudioContext | null; sessionEpoch: number; generation: number };
type ControlResult = { sent: boolean; reason?: string | null };

/** Owns probe preparation and nodes, never publisher/capture authority. */
export class CalibrationProbePlayback {
  constructor(options: {
    getCapture: () => Capture;
    isCurrentCapture: (sessionEpoch: number, generation: number) => boolean;
    isControlOpen: () => boolean;
    sendControl: (message: Record<string, unknown>) => ControlResult;
    onDisconnected: () => void;
    isHidden?: () => boolean;
    nowMs?: () => number;
    timingDiagnostics?: (context: AudioContext, receivedAtMs: number, scheduledContextSeconds: number, scheduledAtMs: number) => unknown;
    warn?: (...args: unknown[]) => void;
  });
  play(requestId: number, leadMs: number): Promise<void>;
  cancelPending(): void;
  retire(): void;
}
