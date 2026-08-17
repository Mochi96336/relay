const TRANSPORT_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;

export function validPlaybackTransportId(value) {
  return typeof value === 'string' && TRANSPORT_PATTERN.test(value) ? value : null;
}

/**
 * sessionStorage belongs to a top-level browsing context, but a newly opened or
 * duplicated same-origin context may begin with a copy of the opener's storage.
 * Reusing that copied transport would make a sibling tab look like a reload.
 * Only an explicit browser `reload` navigation is allowed to inherit the stored
 * logical playback transport. Any other navigation gets a fresh transport.
 */
export function shouldReusePlaybackTransport(storedTransportId, navigationType) {
  return validPlaybackTransportId(storedTransportId) !== null
    && navigationType === 'reload';
}

export function browserNavigationType(performanceObject) {
  try {
    const entries = performanceObject?.getEntriesByType?.('navigation');
    const type = entries?.[0]?.type;
    return typeof type === 'string' ? type : 'unknown';
  } catch {
    return 'unknown';
  }
}
