import { createHash } from 'node:crypto';

const CAPABILITY_PATTERN = /^[0-9a-f]{64}$/;
const BROWSER_PARTICIPANT_PATTERN = /^participant-([0-9a-f]{32})$/;

export function normalizeParticipantCapability(value: unknown) {
  if (typeof value !== 'string') return null;
  const capability = value.trim();
  return CAPABILITY_PATTERN.test(capability) ? capability : null;
}

/**
 * Browser identities publish only a truncated SHA-256 digest of the complete
 * 256-bit capability. Presence can expose the public id without exposing any
 * contiguous capability bits that another client could reuse as authority.
 */
export function participantIdForCapability(value: unknown) {
  const capability = normalizeParticipantCapability(value);
  if (!capability) return null;
  const digest = createHash('sha256').update(capability, 'utf8').digest('hex');
  return `participant-${digest.slice(0, 32)}`;
}

export function participantCapabilityMatches(participantId: string, value: unknown) {
  if (!BROWSER_PARTICIPANT_PATTERN.test(participantId)) return true;
  return participantIdForCapability(value) === participantId;
}

export function browserParticipantIdentity(participantId: string) {
  return BROWSER_PARTICIPANT_PATTERN.test(participantId);
}
