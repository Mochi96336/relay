import type { RoomMicState } from './room-domain.js';
import type { TakeLifecycle } from './take-session.js';

export type TakeStartBlockReason =
  | 'mix-not-active'
  | 'timing-calibration-active'
  | 'mic-required'
  | 'mic-starting'
  | 'mic-reconnecting'
  | 'mic-audio-stalled'
  | 'room-blocked'
  | 'take-active';

export type TakeStartFacts = {
  sessionActive: boolean;
  timingCalibrationActive: boolean;
  songLoaded: boolean;
  /** Product-semantic Mic state for the voice-only Take path. */
  voiceOnlyMicState: RoomMicState;
  roomBlocked: boolean;
  takeLifecycle: TakeLifecycle;
};

export type TakeStartDecision =
  | { ok: true }
  | { ok: false; reason: TakeStartBlockReason };

function voiceOnlyMicBlockReason(state: RoomMicState): TakeStartBlockReason | null {
  if (state === 'live') return null;
  if (state === 'free') return 'mic-required';
  if (state === 'starting') return 'mic-starting';
  if (state === 'reconnecting') return 'mic-reconnecting';
  return 'mic-audio-stalled';
}

/**
 * Owns the room-level decision for whether a new Take may start.
 *
 * Participant authentication and storage/writer failures stay outside this
 * policy. A voice-only room requires current Mic media but deliberately ignores
 * unused Robot/backing health. A loaded Song keeps the existing backing-only
 * recording behavior; correctness repair must not silently redefine the product
 * as Mic-required unless that product decision is made separately.
 *
 * Block reasons are product semantics, not transport diagnostics. In particular,
 * a voice-only room reports the Mic state that prevents recording instead of
 * collapsing it into generic Take readiness, while a loaded Song reports a
 * room-level blocker whose concrete ProductIssue is projected separately.
 */
export function decideTakeStart(facts: TakeStartFacts): TakeStartDecision {
  if (!facts.songLoaded) {
    const micBlockReason = voiceOnlyMicBlockReason(facts.voiceOnlyMicState);
    if (micBlockReason) return { ok: false, reason: micBlockReason };
  }
  if (!facts.sessionActive) return { ok: false, reason: 'mix-not-active' };
  if (facts.timingCalibrationActive) {
    return { ok: false, reason: 'timing-calibration-active' };
  }
  if (facts.songLoaded && facts.roomBlocked) {
    return { ok: false, reason: 'room-blocked' };
  }
  if (facts.takeLifecycle === 'recording' || facts.takeLifecycle === 'finalizing') {
    return { ok: false, reason: 'take-active' };
  }
  return { ok: true };
}
