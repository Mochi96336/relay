// Local durations describe preparation; absolute browser clocks remain diagnostic evidence.
export function probeTimingDiagnostics(context, receivedAtMs, scheduledContextSeconds, scheduledAtMs) {
  try {
    const acknowledgedAtMs = performance.now();
    const stamp = context.getOutputTimestamp?.();
    return {
      processingMs: acknowledgedAtMs - receivedAtMs,
      schedulingDelayMs: Number.isFinite(scheduledAtMs) ? scheduledAtMs - receivedAtMs : undefined,
      acknowledgedAtMs,
      contextSeconds: context.currentTime,
      scheduledContextSeconds,
      baseLatencyMs: context.baseLatency * 1000,
      outputLatencyMs: context.outputLatency * 1000,
      outputContextSeconds: stamp?.contextTime,
      outputPerformanceMs: stamp?.performanceTime,
    };
  } catch { return null; }
}
