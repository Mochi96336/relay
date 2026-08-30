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
  | { kind: 'none' }
  | { kind: 'invalid' }
  | { kind: 'valid'; participantId: string; nickname: string };

export function participantIdentityFromUpgradeRequest(
  request: Pick<IncomingMessage, 'url' | 'headers'>,
): ParticipantIdentityResult {
  const url = new URL(request.url ?? '/', 'http://' + (request.headers.host ?? 'localhost'));
  const rawParticipantId = url.searchParams.get('participant');
  if (rawParticipantId === null) return { kind: 'none' };

  const participantId = normalizeParticipantId(rawParticipantId);
  // Browser participant capabilities are bearer secrets and must never ride in
  // the WebSocket request URL. Query identity remains only for explicit legacy
  // test fixtures, which cannot be enabled in production.
  if (
    !participantId
    || browserParticipantIdentity(participantId)
    || !participantCapabilityMatches(participantId, null)
  ) {
    return { kind: 'invalid' };
  }

  const nickname = normalizeNickname(url.searchParams.get('name')) ?? 'Guest';
  return { kind: 'valid', participantId, nickname };
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
