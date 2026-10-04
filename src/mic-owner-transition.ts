export type MicOwnerTransitionCause =
  | 'publisher-registration'
  | 'explicit-release'
  | 'presence-expired'
  | 'transport-expired';

export type MicOwnerTransition = {
  previousOwnerId: string | null;
  ownerId: string | null;
  cause: MicOwnerTransitionCause;
};

export type MicOwnerTransitionEffects = {
  changed: boolean;
  noteQualityEvent: 'mic-owner-changed' | null;
  cancelRoomSongCommand: 'mic-owner-changed' | 'mic-owner-released' | null;
  cancelSongHandoff: boolean;
  invalidateTimingReason: string | null;
  /** The new owner, whose own last Mic gain replaces the previous singer's. */
  restoreMicGainFor: string | null;
  prepareSongHandoffFor: string | null;
};

const NO_EFFECTS: MicOwnerTransitionEffects = {
  changed: false,
  noteQualityEvent: null,
  cancelRoomSongCommand: null,
  cancelSongHandoff: false,
  invalidateTimingReason: null,
  restoreMicGainFor: null,
  prepareSongHandoffFor: null,
};

/**
 * Room-level consequences of a microphone ownership transition.
 *
 * `ParticipantSession` owns the lease itself. This policy owns what a changed
 * lease means to the rest of the room: pending Song commands may no longer be
 * authorized, a prepared playback handoff may need to be abandoned, an
 * acoustic timing result cannot survive a different singer/capture authority,
 * and the previous singer's Mic gain is wrong for the next device.
 *
 * Transport mechanics deliberately do not live here. Closing a publisher
 * socket, clearing a WebTransport ticket, or cancelling a reconnect timer are
 * I/O concerns for the server adapter. Keeping those out makes this policy
 * deterministic and reusable by every transport path that can change the Mic
 * owner.
 */
export function micOwnerTransitionEffects(
  transition: MicOwnerTransition,
): MicOwnerTransitionEffects {
  const { previousOwnerId, ownerId, cause } = transition;
  if (previousOwnerId === ownerId) return NO_EFFECTS;

  if (ownerId !== null) {
    return {
      changed: true,
      noteQualityEvent: 'mic-owner-changed',
      cancelRoomSongCommand: 'mic-owner-changed',
      cancelSongHandoff: false,
      invalidateTimingReason: 'Microphone ownership changed.',
      restoreMicGainFor: ownerId,
      prepareSongHandoffFor: ownerId,
    };
  }

  if (previousOwnerId === null) return NO_EFFECTS;

  const transportExpired = cause === 'transport-expired';
  return {
    changed: true,
    noteQualityEvent: 'mic-owner-changed',
    cancelRoomSongCommand: 'mic-owner-released',
    // Preserve the existing transport-grace behavior: losing the Mic transport
    // releases ownership but does not itself tear down an independent prepared
    // playback handoff. Explicit release/presence expiry still abandon it.
    cancelSongHandoff: !transportExpired,
    invalidateTimingReason: cause === 'presence-expired'
      ? 'Microphone owner left the Relay session.'
      : transportExpired
        ? 'Microphone transport did not reconnect before its grace period expired.'
        : 'Microphone was released.',
    // A released Mic keeps the last gain; the next owner brings their own.
    restoreMicGainFor: null,
    prepareSongHandoffFor: null,
  };
}
