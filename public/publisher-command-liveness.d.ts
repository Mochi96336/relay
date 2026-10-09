export const DEFAULT_PUBLISHER_COMMAND_ACK_FRESH_MS: number;
export const DEFAULT_PUBLISHER_COMMAND_RECONNECT_MS: number;
export const DEFAULT_PUBLISHER_CONTROL_SILENCE_MS: number;
export const DEFAULT_PUBLISHER_COMMAND_GIVE_UP_MS: number;

export type PublisherCommandLivenessOptions = {
  freshMs?: number;
  reconnectMs?: number;
  silenceMs?: number;
  giveUpMs?: number;
};

export type PublisherCommandLivenessStatus = {
  fresh: boolean;
  reconnect: boolean;
  ackAgeMs: number | null;
};

export class PublisherCommandLiveness {
  constructor(options?: PublisherCommandLivenessOptions);
  reset(): void;
  noteInbound(nowMs: number): void;
  begin(generation: number, nowMs: number): void;
  beginHealthRequest(nowMs: number): number | null;
  cancelHealthRequest(requestId: number): boolean;
  noteAck(generation: number, requestId: number, nowMs: number): boolean;
  status(nowMs: number): PublisherCommandLivenessStatus;
}
