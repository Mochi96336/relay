export function takeTimeLabels(
  entries: ReadonlyArray<{ takeId: string; endedAtMs: number }>,
  format: (endedAtMs: number) => string,
): Map<string, string>;
