export const DEFAULT_RECONNECT_DELAYS_MS: readonly number[];
export const DEFAULT_RECONNECT_STABLE_AFTER_MS: number;

export type ReconnectBackoff = {
  nextDelayMs(): number;
  noteConnected(nowMs: number): void;
  noteClosed(nowMs: number): void;
  reset(): void;
};

export function createReconnectBackoff(options?: {
  delaysMs?: readonly number[];
  stableAfterMs?: number;
}): ReconnectBackoff;
