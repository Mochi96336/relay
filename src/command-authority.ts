export type MicOwnerCommand =
  | 'set-mix'
  | 'set-vocal-fine-tune'
  | 'start-timing-calibration'
  | 'stop-sync-test';

export type CommandActor = {
  participantId: string | null;
  isCurrentPublisher: boolean;
};

export type CommandAuthorityDecision =
  | { ok: true; authority: 'mic-owner' | 'legacy-publisher' }
  | { ok: false; reason: 'mic-free' | 'not-mic-owner' };

/**
 * Product-command authority for state owned by the current singer.
 *
 * Participant identity is the authority boundary: any transport attached to
 * the current Mic owner may issue room-level mix/timing commands. The physical
 * publisher socket is deliberately not required because presence/monitor
 * transports for the same participant are still the same person.
 *
 * Pre-participant clients remain supported through one narrow compatibility
 * path: while there is no participant Mic owner, only the server-selected
 * anonymous publisher transport is treated as the command authority. An
 * arbitrary anonymous monitor/source/unknown socket never inherits that power.
 */
export function authorizeMicOwnerCommand(
  actor: CommandActor,
  micOwnerId: string | null,
): CommandAuthorityDecision {
  if (micOwnerId !== null) {
    return actor.participantId === micOwnerId
      ? { ok: true, authority: 'mic-owner' }
      : { ok: false, reason: 'not-mic-owner' };
  }

  if (actor.participantId === null && actor.isCurrentPublisher) {
    return { ok: true, authority: 'legacy-publisher' };
  }

  return { ok: false, reason: 'mic-free' };
}
