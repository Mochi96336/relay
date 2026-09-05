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
  /**
   * Whether the audible boot probe is measuring.
   *
   * Only a measurement that puts its own sound in the room is a reason to
   * refuse a Take: the probe plays chimes through the phone and the Robot
   * output and needs both captures to itself. Content calibration is a tap on
   * audio the room is already making, so it neither delays a recording nor
   * colours one, and a Take must not wait for it.
   */
  bootProbeCalibrationActive: boolean;
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
 * Decide whether a Take can start from already-derived product facts.
 *
 * The order is also presentation priority because the returned reason is
 * projected through ProductStatus. Prefer an actionable upstream product state
 * over a downstream generic mixer consequence: a Song whose backing route is
 * blocked should say what is wrong with the room audio, not merely that the mix
 * has not become active yet.
 */
export function decideTakeStart(facts: TakeStartFacts): TakeStartDecision {
  if (!facts.songLoaded) {
    const micBlockReason = voiceOnlyMicBlockReason(facts.voiceOnlyMicState);
    if (micBlockReason) return { ok: false, reason: micBlockReason };
  }
  if (facts.bootProbeCalibrationActive) {
    return { ok: false, reason: 'timing-calibration-active' };
  }
  if (facts.songLoaded && facts.roomBlocked) {
    return { ok: false, reason: 'room-blocked' };
  }
  if (!facts.sessionActive) return { ok: false, reason: 'mix-not-active' };
  if (facts.takeLifecycle === 'recording' || facts.takeLifecycle === 'finalizing') {
    return { ok: false, reason: 'take-active' };
  }
  return { ok: true };
}
