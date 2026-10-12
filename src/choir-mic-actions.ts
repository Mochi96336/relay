/**
 * Pure product projection for the future small '+ Secondary Mic' action.
 * The real page MUST keep the action hidden unless multi-publisher admission,
 * follower playback and the mixer are actually feature-ready. No dummy action.
 */
export type ChoirMicActionProjection = {
  primaryAction: 'take-mic' | 'take-over' | 'retry-primary' | 'none';
  secondaryAction: 'join-secondary' | 'leave-secondary' | 'none';
  showSecondaryButton: boolean;
  secondaryEnabled: boolean;
  reason: 'ready' | 'not-supported' | 'no-primary' | 'full' | 'self-primary';
};

export function projectChoirMicActions(input: {
  featureReady: boolean;
  participantId: string;
  primaryId: string | null;
  secondaryIds: readonly string[];
  maxSingers: number;
  primaryTransportHealthy: boolean;
}): ChoirMicActionProjection {
  const ownPrimary = input.primaryId === input.participantId;
  const ownSecondary = input.secondaryIds.includes(input.participantId);
  const primaryAction = ownPrimary
    ? (input.primaryTransportHealthy ? 'none' : 'retry-primary')
    : input.primaryId ? 'take-over' : 'take-mic';

  if (!input.featureReady) {
    return {
      primaryAction, secondaryAction: 'none', showSecondaryButton: false,
      secondaryEnabled: false, reason: 'not-supported',
    };
  }
  if (ownPrimary) {
    return {
      primaryAction, secondaryAction: 'none', showSecondaryButton: false,
      secondaryEnabled: false, reason: 'self-primary',
    };
  }
  if (ownSecondary) {
    return {
      primaryAction, secondaryAction: 'leave-secondary', showSecondaryButton: true,
      secondaryEnabled: true, reason: 'ready',
    };
  }
  if (!input.primaryId) {
    // Existing secondary singers remain on their seat, but a NEW secondary
    // cannot join until someone explicitly claims an empty primary seat.
    return {
      primaryAction, secondaryAction: 'none', showSecondaryButton: false,
      secondaryEnabled: false, reason: 'no-primary',
    };
  }
  const full = input.secondaryIds.length + 1 >= input.maxSingers;
  return {
    primaryAction, secondaryAction: 'join-secondary', showSecondaryButton: true,
    secondaryEnabled: !full, reason: full ? 'full' : 'ready',
  };
}
