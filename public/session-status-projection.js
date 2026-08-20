function validRevision(value) {
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
}

/**
 * Reduces Presence snapshots from multiple sockets without allowing an older
 * revision, or a late packet from a retired server process, to rewind Mic UI.
 */
export function reduceSessionOwnership(previous, message) {
  if (!message || typeof message !== 'object') return null;
  const revision = validRevision(message.revision);
  if (revision === null) return null;

  const previousIncarnation = typeof previous?.serverIncarnation === 'string'
    ? previous.serverIncarnation
    : null;
  const incomingIncarnation = typeof message.serverIncarnation === 'string'
    ? message.serverIncarnation
    : previousIncarnation;
  const retiredIncarnations = new Set(
    Array.isArray(previous?.retiredIncarnations) ? previous.retiredIncarnations : [],
  );

  if (incomingIncarnation && retiredIncarnations.has(incomingIncarnation)) return null;

  let comparisonRevision = Number(previous?.revision);
  if (!Number.isSafeInteger(comparisonRevision) || comparisonRevision < 0) comparisonRevision = -1;
  if (
    previousIncarnation
    && incomingIncarnation
    && incomingIncarnation !== previousIncarnation
  ) {
    retiredIncarnations.add(previousIncarnation);
    comparisonRevision = -1;
  }
  if (revision < comparisonRevision) return null;

  return {
    revision,
    serverIncarnation: incomingIncarnation,
    micOwnerId: typeof message.micOwnerId === 'string' ? message.micOwnerId : null,
    retiredIncarnations: [...retiredIncarnations],
  };
}
