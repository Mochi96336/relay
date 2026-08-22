export function authorityState({
  authorityFresh = false,
  lastKnownSnapshot = null,
  commandChannelFresh = false,
  authorized = false,
  serverAllowed = false,
} = {}) {
  const fresh = authorityFresh === true;
  const channelFresh = commandChannelFresh === true;
  const isAuthorized = authorized === true;
  const allowed = serverAllowed === true;

  return {
    authorityFresh: fresh,
    lastKnownSnapshot: lastKnownSnapshot ?? null,
    commandChannelFresh: channelFresh,
    authorized: isAuthorized,
    serverAllowed: allowed,
    actionable: fresh && channelFresh && isAuthorized && allowed,
    stale: lastKnownSnapshot != null && !fresh,
    unknown: lastKnownSnapshot == null,
  };
}

export function authorityPresentation(state) {
  if (!state || state.lastKnownSnapshot == null) return 'unknown';
  if (state.authorityFresh !== true || state.commandChannelFresh !== true) return 'reconnecting';
  return 'fresh';
}
