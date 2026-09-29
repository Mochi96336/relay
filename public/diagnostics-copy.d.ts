export type DiagnosticsTranslator = (key: string, vars?: Record<string, string | number>) => string;

export const DIAGNOSTICS_MESSAGES: {
  en: Record<string, string>;
  'zh-Hant': Record<string, string>;
};

export function diagnosticsTranslator(locale?: string): DiagnosticsTranslator;
export function plural(t: DiagnosticsTranslator, base: string, count: number): string;
