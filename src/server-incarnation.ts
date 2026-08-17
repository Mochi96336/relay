import { randomUUID } from 'node:crypto';

/**
 * One opaque identity for this Relay process lifetime.
 *
 * Revisions are intentionally in-memory and restart from zero. Clients must
 * compare revisions only inside the same server incarnation; otherwise a phone
 * that survives a Relay restart can reject the new authoritative state forever.
 */
export const SERVER_INCARNATION = randomUUID();
