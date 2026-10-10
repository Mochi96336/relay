/** Whitelist bounded numeric evidence; never use this payload to align audio. */
export function sanitizeProbeTimingDiagnostics(value: unknown) {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  const result: Record<string, number | null> = {};
  for (const key of ['processingMs', 'acknowledgedAtMs', 'contextSeconds',
    'scheduledContextSeconds', 'baseLatencyMs', 'outputLatencyMs',
    'outputContextSeconds', 'outputPerformanceMs']) {
    const n = source[key];
    result[key] = typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1e12 ? n : null;
  }
  return result;
}
