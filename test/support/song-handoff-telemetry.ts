import { youtubeTelemetry } from './youtube-telemetry.js';

/** A playback tab's YouTube telemetry, as the Song handoff tests send it. */
export function telemetry(currentTime: number, overrides: Record<string, unknown> = {}) {
  return youtubeTelemetry({ currentTime, ...overrides });
}
