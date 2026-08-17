import type { TakeLifecycle } from './take-session.js';

export type CalibrationStartMode = 'content' | 'boot-probe';
export type CalibrationStartBlockReason =
  | 'take-active'
  | 'calibration-active'
  | 'sources-not-connected'
  | 'sources-not-streaming'
  | 'phone-not-playing';

export type CalibrationStartFacts = {
  takeLifecycle: TakeLifecycle;
  calibrationActive: boolean;
  sessionActive: boolean;
  backingConnected: boolean;
  publisherControlConnected: boolean;
  backingStreaming: boolean;
  micStreaming: boolean;
  robotProbeTimingActive: boolean;
  timelineConnected: boolean;
  timelineState: number | null;
};

export type CalibrationStartDecision =
  | { ok: true; mode: CalibrationStartMode }
  | { ok: false; reason: CalibrationStartBlockReason };

/**
 * Owns the room-level prerequisites for starting timing calibration.
 *
 * Mic-owner authorization remains an actor boundary in the server/browser.
 * This policy owns only room facts. Robot probe calibration intentionally does
 * not require a playing phone timeline; content correlation does.
 */
export function decideCalibrationStart(
  facts: CalibrationStartFacts,
): CalibrationStartDecision {
  if (facts.takeLifecycle === 'recording' || facts.takeLifecycle === 'finalizing') {
    return { ok: false, reason: 'take-active' };
  }
  if (facts.calibrationActive) return { ok: false, reason: 'calibration-active' };
  if (!facts.sessionActive || !facts.backingConnected || !facts.publisherControlConnected) {
    return { ok: false, reason: 'sources-not-connected' };
  }
  if (!facts.backingStreaming || !facts.micStreaming) {
    return { ok: false, reason: 'sources-not-streaming' };
  }
  if (facts.robotProbeTimingActive) return { ok: true, mode: 'boot-probe' };
  if (!facts.timelineConnected || facts.timelineState !== 1) {
    return { ok: false, reason: 'phone-not-playing' };
  }
  return { ok: true, mode: 'content' };
}
