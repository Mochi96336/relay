export const DEFAULT_PUBLISHER_COMMAND_ACK_FRESH_MS: number;
export const DEFAULT_PUBLISHER_COMMAND_RECONNECT_MS: number;

export type PublisherCommandLivenessOptions = {
  freshMs?: number;
  reconnectMs?: number;
};

export type PublisherCommandLivenessStatus = {
  fresh: boolean;
  reconnect: boolean;
  ackAgeMs: number | null;
};

export class PublisherCommandLiveness {
  constructor(options?: PublisherCommandLivenessOptions);
  reset(): void;
  begin(generation: number, nowMs: number): void;
  noteAck(generation: number, nowMs: number, requestSentAtMs?: number): boolean;
  status(nowMs: number): PublisherCommandLivenessStatus;
}
