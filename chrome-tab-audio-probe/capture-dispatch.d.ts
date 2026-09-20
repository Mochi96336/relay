export const TAB_CAPTURE_DISPATCH_BACKLOG_MS: number;

export type TabCaptureDispatchResult = {
  measurable: boolean;
  lagMs: number | null;
  stale: boolean;
};

export function classifyTabCaptureDispatch(input?: {
  currentContextTimeSeconds?: number | null;
  capturedAtContextTimeSeconds?: number | null;
  backlogMs?: number;
}): TabCaptureDispatchResult;
