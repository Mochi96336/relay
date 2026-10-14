import type { ParticipantSession } from './participant-session.js';
import type { MicRuntime } from './mic-runtime.js';
import type { TakeLifecycle } from './take-session.js';
import type { ChoirRestartApproval } from './choir-room-restart-coordinator-experiment.js';

/**
 * SERVER-ONLY policy, not a client registration parser.
 *
 * Current production Mic owner is the FIRST Choir primary. The YouTube
 * playback leader can be a different participant: playback-clock authority
 * does not grant the primary voice or somebody else's microphone.
 *
 * An authenticated B must explicitly consent to joining this Room Epoch.
 * Mere presence / an available microphone is NOT that consent. No production
 * handler currently collects or grants secondary consent.
 */
export function authorizeChoirRestartWithLiveRoles(
  request: ChoirRestartApproval,
  sources: {
    participants: Pick<ParticipantSession, 'micOwnerId' | 'participant'>;
    mic: Pick<MicRuntime, 'mediaOwnerId' | 'publisherConnected'>;
    takeLifecycle: TakeLifecycle;
    /** Server-owned, explicit B consent for this exact proposed room. */
    secondaryConsent: (participantId: string, proposedRoomEpoch: number) => boolean;
  },
): boolean {
  const { participants, mic, takeLifecycle, secondaryConsent } = sources;
  return Boolean(
    request.actorParticipantId
    && request.actorParticipantId === request.primaryId
    && request.primaryId === participants.micOwnerId
    && mic.mediaOwnerId === request.primaryId
    && mic.publisherConnected
    && participants.participant(request.primaryId)?.connected === true
    && request.secondaryId !== request.primaryId
    && participants.participant(request.secondaryId)?.connected === true
    && takeLifecycle !== 'recording'
    && takeLifecycle !== 'finalizing'
    && secondaryConsent(request.secondaryId, request.expectedRetiredRoomEpoch + 1)
  );
}
