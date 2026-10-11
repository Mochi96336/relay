import type { DiagnosticRow } from './diagnostics-model.js';
import type { DiagnosticsTranslator } from './diagnostics-copy.js';
export function describeListeners(facts?: {statusz?: any; session?: any; selfId?: string}, t?: DiagnosticsTranslator): {id: string; title: string; summary: string; rows: DiagnosticRow[]}[] | null;
