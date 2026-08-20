let player = null;
let playbackRole = 'connecting';
let reviewActive = false;
let restoreAudible = false;
let remuteTimer = null;

function clearRemuteTimer() {
  if (remuteTimer === null) return;
  clearInterval(remuteTimer);
  remuteTimer = null;
}

function enforceReviewMute() {
  if (!reviewActive || !player) return;
  try { player.mute(); } catch {}
}

function armRemuteTimer() {
  clearRemuteTimer();
  if (!reviewActive) return;
  remuteTimer = setInterval(enforceReviewMute, 250);
}

function attachPlayer(nextPlayer) {
  if (!nextPlayer) return;
  // YT can return the player object before every API method is usable. Re-run
  // this attachment from onReady even for the same object so a late `unMute`
  // method still receives the Take-review guard.
  player = nextPlayer;

  const originalUnMute = typeof nextPlayer.unMute === 'function'
    ? nextPlayer.unMute.bind(nextPlayer)
    : null;
  if (originalUnMute && nextPlayer.unMute?.__relayTakeReviewGuard !== true) {
    const guardedUnMute = (...args) => {
      if (reviewActive) {
        // Handoff/prewarm code may legitimately try to restore audibility while
        // a Take is playing. Remember that intent, but keep the local iframe
        // muted until review ends; no shared play/pause/timeline state changes.
        restoreAudible = true;
        return undefined;
      }
      return originalUnMute(...args);
    };
    guardedUnMute.__relayTakeReviewGuard = true;
    nextPlayer.unMute = guardedUnMute;
  }

  enforceReviewMute();
}

function wrapPlayerConstructor() {
  const YT = window.YT;
  const OriginalPlayer = YT?.Player;
  if (typeof OriginalPlayer !== 'function' || OriginalPlayer.__relayLocalAudibilityWrapped) return;

  function RelayPlayer(target, options = {}) {
    const originalReady = options?.events?.onReady;
    const wrappedOptions = {
      ...options,
      events: {
        ...(options?.events ?? {}),
        onReady(event) {
          attachPlayer(event?.target);
          enforceReviewMute();
          originalReady?.(event);
        },
      },
    };
    const created = new OriginalPlayer(target, wrappedOptions);
    attachPlayer(created);
    return created;
  }

  Object.setPrototypeOf(RelayPlayer, OriginalPlayer);
  RelayPlayer.prototype = OriginalPlayer.prototype;
  RelayPlayer.__relayLocalAudibilityWrapped = true;
  YT.Player = RelayPlayer;
}

if (window.YT?.Player) {
  wrapPlayerConstructor();
} else {
  const previousReady = window.onYouTubeIframeAPIReady;
  window.onYouTubeIframeAPIReady = () => {
    previousReady?.();
    // Promise continuations waiting on the API run after this callback returns,
    // so wrapping here still happens before youtube.js constructs its player.
    wrapPlayerConstructor();
  };
}

window.addEventListener('relay:playback-view', (event) => {
  playbackRole = typeof event.detail?.role === 'string' ? event.detail.role : 'connecting';
  if (reviewActive) {
    enforceReviewMute();
    return;
  }
  if (playbackRole !== 'holder') restoreAudible = false;
});

window.addEventListener('relay-take-review-playback', (event) => {
  const active = event.detail?.active === true;
  if (active === reviewActive) return;
  reviewActive = active;

  if (reviewActive) {
    if (player) {
      try {
        if (player.isMuted?.() === false) restoreAudible = true;
      } catch {}
    }
    enforceReviewMute();
    armRemuteTimer();
    return;
  }

  clearRemuteTimer();
  if (!restoreAudible) return;
  // Only the current playback holder may become audible again. If authority
  // moved away during review, discard the old local restoration intent rather
  // than reviving a stale iframe later.
  if (playbackRole !== 'holder' || !player) {
    restoreAudible = false;
    return;
  }

  restoreAudible = false;
  try { player.unMute(); } catch {}
});

window.addEventListener('beforeunload', clearRemuteTimer, { once: true });
