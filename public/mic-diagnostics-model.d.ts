import type { DiagnosticsTranslator } from './diagnostics-copy.js';

export type MicDiagnosticTone = 'ok' | 'warn' | 'bad' | 'neutral';

export type MicDiagnosticRow = {
  key: 'audio' | 'level' | 'problems' | 'path' | 'repair' | 'buffer' | 'send' | 'input' | 'drift';
  label: string;
  value: string;
  note: string;
  tone: MicDiagnosticTone;
};

export const LOW_HEADROOM_MS: number;

export function describeMicAudio(status: unknown, t?: DiagnosticsTranslator): MicDiagnosticRow;
export function describeMicTransport(status: unknown, t?: DiagnosticsTranslator): MicDiagnosticRow[];
