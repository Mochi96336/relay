import type { IncomingMessage } from 'node:http';

import {
  browserParticipantIdentity,
  participantCapabilityMatches,
} from './participant-capability.js';
import {
  normalizeNickname,
  normalizeParticipantId,
} from './participant-session.js';

export type ParticipantIdentityResult =
  | { kind: 'invalid' }
  | { kind: 'valid'; participantId: string; nickname: string };

/**
 * Browser participant capabilities are bearer secrets and must never ride in
 * the WebSocket request URL, so a socket that names a participant there is
 * refused rather than quietly treated as anonymous.
 */
export function upgradeRequestNamesParticipant(
  request: Pick<IncomingMessage, 'url'>,
) {
  // The same fixed origin as upgrade admission in relay-socket-server.ts, which
  // already refused any target this cannot parse. Should one get here anyway,
  // refuse it: a URL nobody can read is not proof that it names nobody.
  let url: URL;
  try {
    url = new URL(request.url ?? '/', 'http://localhost');
  } catch {
    return true;
  }
  return url.searchParams.has('participant');
}

export function participantIdentityFromAuthentication(
  payload: Record<string, unknown>,
): ParticipantIdentityResult {
  const participantId = normalizeParticipantId(payload.participantId);
  if (
    !participantId
    || !browserParticipantIdentity(participantId)
    || !participantCapabilityMatches(participantId, payload.capability)
  ) {
    return { kind: 'invalid' };
  }
  const nickname = normalizeNickname(payload.nickname) ?? 'Guest';
  return { kind: 'valid', participantId, nickname };
}
