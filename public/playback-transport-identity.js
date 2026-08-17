const TRANSPORT_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;
export const PLAYBACK_TRANSPORT_KEY = 'relay.playbackTransportId.v1';
export const PLAYBACK_GENERATION_KEY = 'relay.playbackGeneration.v1';

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

/**
 * Prepare session storage before youtube-sync reads its logical playback ID.
 *
 * A real reload keeps the stored transport and its monotonic generation. A new
 * or duplicated browsing context must rotate both values even if the browser
 * copied sessionStorage from an opener. Unknown navigation metadata fails
 * closed: losing reload continuation on an old browser is safer than letting a
 * sibling tab silently supersede a healthy playback controller.
 */
export function preparePlaybackTransportStorage(storage, navigationType) {
  if (!storage || typeof storage.getItem !== 'function') return 'unavailable';

  const storedTransportId = storage.getItem(PLAYBACK_TRANSPORT_KEY);
  if (shouldReusePlaybackTransport(storedTransportId, navigationType)) return 'reload';

  if (storedTransportId !== null || storage.getItem(PLAYBACK_GENERATION_KEY) !== null) {
    storage.removeItem(PLAYBACK_TRANSPORT_KEY);
    storage.removeItem(PLAYBACK_GENERATION_KEY);
    return validPlaybackTransportId(storedTransportId) ? 'rotated' : 'reset';
  }

  return 'fresh';
}

// song-role imports this module before youtube-sync evaluates its own body. Keep
// the browser bootstrap here so copied sessionStorage is retired before the
// playback transport/generation are read. Node tests have no window and remain
// pure imports.
if (typeof window !== 'undefined' && typeof sessionStorage !== 'undefined') {
  preparePlaybackTransportStorage(sessionStorage, browserNavigationType(performance));
}
