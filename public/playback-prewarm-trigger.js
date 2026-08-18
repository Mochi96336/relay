function closestActionTarget(event, selector) {
  const target = event?.target;
  if (!target || typeof target.closest !== 'function') return null;
  return target.closest(selector);
}

/**
 * The first Mic/takeover tap is a real user gesture and, during a confirmed
 * takeover, is followed by a human decision interval. Spend that otherwise
 * idle time warming the local YouTube player without granting this page any
 * room authority.
 *
 * Presence owns confirmation and cancellation semantics. This capture listener
 * exists only so the first Mic click can start speculative media work before
 * Presence stops/redirects the button event. Cancellation is dispatched by
 * Presence after it has decided the Cancel action is actually valid.
 *
 * This module is also imported transitively by pure playback-continuation tests
 * in Node. Keep every DOM side effect behind a browser guard so importing those
 * helpers does not manufacture a browser requirement.
 */
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  document.addEventListener('click', (event) => {
    if (closestActionTarget(event, '#start-publisher')) {
      window.dispatchEvent(new CustomEvent('relay:playback-prewarm-intent'));
    }
  }, true);

  // Once Mic startup itself fails, there is no formal handoff coming that could
  // consume the speculative preparation. Park it instead of leaving a stale
  // local player staged behind the observer surface.
  window.addEventListener('relay-microphone-start-failed', () => {
    window.dispatchEvent(new CustomEvent('relay:playback-prewarm-cancel'));
  });
  window.addEventListener('relay-mic-takeover-rejected', () => {
    window.dispatchEvent(new CustomEvent('relay:playback-prewarm-cancel'));
  });
}
