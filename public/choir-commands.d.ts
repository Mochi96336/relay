export function choirCommandMessage(payload: unknown): Record<string, unknown> | null;
export class ChoirSeatCommands {
  outgoing(message: Record<string, unknown>): Record<string, unknown>;
  accepts(reply: Record<string, unknown>): boolean;
}
