import type { MicOwnerTransitionEffects } from './mic-owner-transition.js';

export type MicOwnerTransitionApplicationPort = {
  noteQualityEvent(event: 'mic-owner-changed'): void;
  cancelRoomSongCommand(reason: 'mic-owner-changed' | 'mic-owner-released'): void;
  cancelSongHandoff(): boolean;
  publishSongHandoffCancellation(): void;
  invalidateTiming(reason: string): void;
  prepareSongHandoff(participantId: string): void;
};

export type AppliedMicOwnerTransition = {
  applied: boolean;
  songHandoffCancelled: boolean;
  songHandoffPrepared: boolean;
};

/**
 * Applies canonical room-level Mic ownership effects through a narrow port.
 *
 * The domain policy says what a lease transition means; this function orders
 * those consequences. The server adapter only has to provide the concrete I/O
 * callbacks (SongSession broadcast, timing invalidation, Take evidence, etc.).
 * Transport cleanup remains outside this boundary on purpose: closing sockets,
 * clearing media tickets and reconnect timers are physical adapter concerns.
 */
export function applyMicOwnerTransitionEffects(
  effects: MicOwnerTransitionEffects,
  port: MicOwnerTransitionApplicationPort,
): AppliedMicOwnerTransition {
  if (!effects.changed) {
    return {
      applied: false,
      songHandoffCancelled: false,
      songHandoffPrepared: false,
    };
  }

  if (effects.noteQualityEvent) {
    port.noteQualityEvent(effects.noteQualityEvent);
  }
  if (effects.cancelRoomSongCommand) {
    port.cancelRoomSongCommand(effects.cancelRoomSongCommand);
  }

  let songHandoffCancelled = false;
  if (effects.cancelSongHandoff) {
    songHandoffCancelled = port.cancelSongHandoff();
    if (songHandoffCancelled) port.publishSongHandoffCancellation();
  }

  if (effects.invalidateTimingReason) {
    port.invalidateTiming(effects.invalidateTimingReason);
  }

  let songHandoffPrepared = false;
  if (effects.prepareSongHandoffFor) {
    port.prepareSongHandoff(effects.prepareSongHandoffFor);
    songHandoffPrepared = true;
  }

  return {
    applied: true,
    songHandoffCancelled,
    songHandoffPrepared,
  };
}
