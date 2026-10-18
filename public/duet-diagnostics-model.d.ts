import type { DiagnosticFacts, DiagnosticRow } from './diagnostics-model.js';
import type { DiagnosticsTranslator } from './diagnostics-copy.js';

export type DuetDiagnosticsBlock = {
  title: string;
  rows: DiagnosticRow[];
  advanced: DiagnosticRow[];
};

export function describeDuetMic(facts?: DiagnosticFacts, t?: DiagnosticsTranslator): (DuetDiagnosticsBlock & { mainTitle: string }) | null;
export function describeDuetTiming(facts?: DiagnosticFacts, t?: DiagnosticsTranslator): DuetDiagnosticsBlock | null;
