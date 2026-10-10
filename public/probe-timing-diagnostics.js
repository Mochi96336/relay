// Optional evidence only: browser clocks never become mixer authority here.
export function probeTimingDiagnostics(context, receivedAtMs, scheduledContextSeconds) {
  try {
    const acknowledgedAtMs = performance.now();
    const stamp = context.getOutputTimestamp?.();
    return {
      processingMs: acknowledgedAtMs - receivedAtMs,
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
