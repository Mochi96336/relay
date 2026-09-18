export type RelayBackingGraceExpiryInput = {
  roomHasSong: boolean;
  micArmed: boolean;
};

export type RelayBackingGraceExpiryDependencies = {
  stopLiveSource: () => void;
  retireRobotRoute: () => void;
  clearRobotContentTransition: () => void;
  invalidateMicTiming: (message: string) => void;
  reportStatus: () => void;
};

export const BACKING_GRACE_VOICE_ONLY_TIMING_REASON =
  'Backing route ended while the room continued voice-only.';

/**
 * Owns the room-level consequence of an expired Backing reconnect grace.
 *
 * BackingRuntime still owns transport identity and the grace timer itself. The
 * server still owns the live Song/Mic facts passed into this seam. Once expiry
 * is real, this coordinator decides whether the room must stop entirely or can
 * remain live as voice-only, and preserves the effects required by that
 * downgrade.
 */
export function createRelayBackingGraceExpiryCoordinator(
  dependencies: RelayBackingGraceExpiryDependencies,
) {
  return {
    expire(input: RelayBackingGraceExpiryInput) {
      if (input.roomHasSong || !input.micArmed) {
        dependencies.stopLiveSource();
        return 'stopped' as const;
      }

      dependencies.retireRobotRoute();
      dependencies.clearRobotContentTransition();
      dependencies.invalidateMicTiming(BACKING_GRACE_VOICE_ONLY_TIMING_REASON);
      dependencies.reportStatus();
      return 'voice-only' as const;
    },
  } as const;
}
