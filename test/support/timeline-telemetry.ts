import { youtubeTelemetry } from './youtube-telemetry.js';

/** A playback tab's YouTube telemetry, as the Song timeline tests send it. */
export function telemetry(overrides: Record<string, unknown> = {}) {
  return youtubeTelemetry({ bufferedFraction: 0.5, ...overrides });
}
