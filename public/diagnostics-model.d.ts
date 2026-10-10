import type { DiagnosticsTranslator } from './diagnostics-copy.js';

export type DiagnosticTone = 'ok' | 'warn' | 'bad' | 'neutral';

export type DiagnosticRow = {
  key: string;
  label: string;
  value: string;
  note: string;
  tone: DiagnosticTone;
};

/** Snapshots Technical details already holds; every field is optional. */
export type DiagnosticFacts = {
  product?: unknown;
  readiness?: unknown;
  source?: unknown;
  statusz?: unknown;
  timing?: unknown;
  timeline?: unknown;
};

export function describeOverview(facts?: DiagnosticFacts, t?: DiagnosticsTranslator): DiagnosticRow[];
export function describeSession(facts?: DiagnosticFacts, t?: DiagnosticsTranslator): DiagnosticRow[];
export function describeAudio(facts?: DiagnosticFacts, t?: DiagnosticsTranslator): DiagnosticRow[];
export function describeTiming(facts?: DiagnosticFacts, t?: DiagnosticsTranslator): DiagnosticRow[];
export function describeRobot(facts?: DiagnosticFacts, t?: DiagnosticsTranslator): DiagnosticRow[];
