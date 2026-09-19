export const DEFAULT_CAPTURE_DISPATCH_BACKLOG_MS: number;

export type CaptureDispatchClassification = {
  measurable: boolean;
  lagMs: number | null;
  stale: boolean;
};

export function classifyCaptureDispatch(input?: {
  currentContextTimeSeconds?: number | null;
  capturedAtContextTimeSeconds?: number | null;
  backlogMs?: number;
}): CaptureDispatchClassification;
