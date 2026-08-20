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
  | { ok: false; mode: CalibrationStartMode; reason: CalibrationStartBlockReason };

/**
 * Owns the room-level prerequisites for starting timing calibration.
 *
 * Mic-owner authorization remains an actor boundary in the server/browser.
 * This policy owns only room facts.
 *
 * `streaming` means the capture PCM timeline is fresh and still advancing. It
 * does not mean that song content is audible. Robot boot-probe calibration can
 * therefore run while YouTube is paused/disconnected as long as Mic + backing
 * capture keep delivering fresh PCM frames; content correlation still needs a
 * playing phone timeline.
 */
export function decideCalibrationStart(
  facts: CalibrationStartFacts,
): CalibrationStartDecision {
  const mode: CalibrationStartMode = facts.robotProbeTimingActive ? 'boot-probe' : 'content';

  if (facts.takeLifecycle === 'recording' || facts.takeLifecycle === 'finalizing') {
    return { ok: false, mode, reason: 'take-active' };
  }
  if (facts.calibrationActive) return { ok: false, mode, reason: 'calibration-active' };
  if (!facts.sessionActive || !facts.backingConnected || !facts.publisherControlConnected) {
    return { ok: false, mode, reason: 'sources-not-connected' };
  }
  if (!facts.backingStreaming || !facts.micStreaming) {
    return { ok: false, mode, reason: 'sources-not-streaming' };
  }

  if (mode === 'boot-probe') return { ok: true, mode };

  if (!facts.timelineConnected || facts.timelineState !== 1) {
    return { ok: false, mode, reason: 'phone-not-playing' };
  }
  return { ok: true, mode };
}
