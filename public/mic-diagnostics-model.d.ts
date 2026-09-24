export type MicDiagnosticTone = 'ok' | 'warn' | 'bad' | 'neutral';

export type MicDiagnosticRow = {
  key: 'audio' | 'problems' | 'path' | 'repair' | 'buffer' | 'send' | 'input' | 'drift';
  label: string;
  value: string;
  note: string;
  tone: MicDiagnosticTone;
};

export const LOW_HEADROOM_MS: number;

export function describeMicAudio(status: unknown): MicDiagnosticRow;
export function describeMicTransport(status: unknown): MicDiagnosticRow[];
