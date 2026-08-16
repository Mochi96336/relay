export type MicOwnerCommand =
  | 'set-mix'
  | 'set-vocal-fine-tune'
  | 'start-timing-calibration'
  | 'start-sync-test'
  | 'stop-sync-test';

export type CommandActor = {
  participantId: string | null;
  isCurrentPublisher: boolean;
};

export type CommandAuthorityDecision =
  | { ok: true; authority: 'mic-owner' | 'legacy-publisher' | 'room-open' }
  | { ok: false; reason: 'not-mic-owner' | 'no-identity' };

/**
 * Product-command authority for state owned by the current singer.
 *
 * Participant identity is the authority boundary: any transport attached to
 * the current Mic owner may issue room-level mix/timing commands. The physical
 * publisher socket is deliberately not required because presence/monitor
 * transports for the same participant are still the same person.
 *
 * With nobody singing there is no owner for the ownership to protect, so any
 * identified participant may adjust the room. Locking the controls until
 * somebody takes the microphone reads as a broken app rather than as a rule:
 * the song level is heard by everyone in the room, not only by the singer.
 * What the rule exists to prevent is a *second* person overriding whoever is
 * currently singing, and that is still enforced above.
 *
 * Pre-participant clients remain supported through one narrow compatibility
 * path: while there is no participant Mic owner, the server-selected anonymous
 * publisher transport is also an authority. An arbitrary anonymous
 * monitor/source/unknown socket never inherits that power.
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

  if (actor.participantId !== null) {
    return { ok: true, authority: 'room-open' };
  }

  if (actor.isCurrentPublisher) {
    return { ok: true, authority: 'legacy-publisher' };
  }

  return { ok: false, reason: 'no-identity' };
}
