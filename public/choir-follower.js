import { projectFollowerRoom, decideFollowerAction } from './choir-follower-clock.js';

// B uses the EXISTING Song surface. This player never becomes the room leader,
// sends playback telemetry, or supplies a Mic acoustic calibration anchor.
const stage = document.querySelector('.song-stage');
const host = document.querySelector('#choir-follower-player');
const statusNode = document.querySelector('#choir-follower-status');
const positionNode = document.querySelector('#choir-follower-position');
const unmuteButton = document.querySelector('#choir-follower-unmute');
const t = (key) => window.relayI18n?.t(key) ?? key;

let eligible = false;
let role = 'connecting';
let latestRoom = null;
let roomReceivedAtMs = null;
let player = null;
let playerReady = false;
let starting = false;
let localVideoId = null;
let failedVideoId = null;
let lastSeekAtMs = Number.NEGATIVE_INFINITY;
let lastPlayAttemptMs = Number.NEGATIVE_INFINITY;
let generation = 0;
let apiPromise = null;
let autoplayBlocked = false;
/** Since when the room plays but B's own song does not; Listen yields only so long. */
let localNotPlayingSinceMs = null;
const LOCAL_START_GRACE_MS = 10_000;
let statusKey = null;
let localBackingAudibleRole = false;
let readyTimer = null;
let startAttempts = 0;
let retryAtMs = 0;
let attemptedRate = null;
/**
 * The local song starts muted, which every browser lets a script play, so B
 * is in time (and aligned by YouTube time) at once. It is then unmuted; where
 * the browser needs a tap for sound (iOS), it keeps playing muted and B is
 * asked to tap the player. muted → unmuting → audible | tap-for-sound.
 */
let soundState = 'muted';
/** YouTube's last error code, and when a failed video is tried again. */
let lastErrorCode = null;
let videoErrors = 0;
let videoRetryAtMs = 0;
let unmuteTimer = null;
/** What B is asked to tap for sound: the button, or (if that was not enough) the video. */
let tapSound = 'choir.followerTapSound';

function setLocalPlayback(active) {
  if (active === localBackingAudibleRole) return;
  localBackingAudibleRole = active;
  window.dispatchEvent(new CustomEvent('relay-choir-local-playback', {
    detail: { active },
  }));
}
function failInitialization() {
  resetPlayer();
  // Keep trying while B is in, more slowly each time: giving up after three
  // slow loads left a joined B with no song for the rest of the session.
  retryAtMs = performance.now() + Math.min(15_000, 5_000 * Math.max(1, startAttempts));
  setStatus('choir.followerVideoError');
}

function setStatus(key) {
  if (statusKey === key) return;
  statusKey = key;
  if (statusNode) {
    statusNode.hidden = !key;
    statusNode.textContent = key ? t(key) : '';
  }
  if (unmuteButton) unmuteButton.hidden = key !== 'choir.followerTapSound';
}
function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const value = Math.floor(seconds);
  return Math.floor(value / 60) + ':' + String(value % 60).padStart(2, '0');
}
function resetPlayer() {
  generation++;
  clearTimeout(readyTimer);
  readyTimer = null;
  clearTimeout(unmuteTimer);
  unmuteTimer = null;
  soundState = 'muted';
  tapSound = 'choir.followerTapSound';
  setLocalPlayback(false);
  attemptedRate = null;
  try { player?.pauseVideo(); } catch {}
  try { player?.destroy(); } catch {}
  player = null;
  playerReady = false;
  starting = false;
  localVideoId = null;
  failedVideoId = null;
  lastSeekAtMs = Number.NEGATIVE_INFINITY;
  lastPlayAttemptMs = Number.NEGATIVE_INFINITY;
  autoplayBlocked = false;
  localNotPlayingSinceMs = null;
  if (host) host.replaceChildren();
  if (positionNode) positionNode.textContent = '--:-- / --:--';
  setStatus(null);
}
function currentRoom() {
  return projectFollowerRoom(latestRoom, roomReceivedAtMs, performance.now());
}
function showFollower() {
  const visible = eligible && role === 'observer'
    && /^[A-Za-z0-9_-]{11}$/.test(latestRoom?.videoId ?? '');
  if (host) host.hidden = !visible;
  if (positionNode) positionNode.hidden = !visible;
  if (stage) stage.dataset.choirFollower = visible ? 'active' : 'off';
  if (!visible) {
    startAttempts = 0;
    retryAtMs = 0;
    setLocalPlayback(false);
    if (player || starting) resetPlayer();
    setStatus(null);
    return;
  }
  if (!player && !starting && currentRoom()) void startPlayer();
}

function loadYouTubeAPI() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    let settled = false;
    const finish = () => {
      if (settled || !window.YT?.Player) return;
      settled = true;
      resolve(window.YT);
    };
    window.onYouTubeIframeAPIReady = () => {
      try { previous?.(); } finally { finish(); }
    };
    if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.async = true;
      script.addEventListener('error', () => {
        if (settled) return;
        settled = true;
        apiPromise = null;
        reject(new Error('YouTube API failed'));
      }, { once: true });
      document.head.append(script);
    }
    // The primary player may already have injected this script.
    let attempts = 0;
    const check = () => {
      if (settled) return;
      if (window.YT?.Player) { finish(); return; }
      if (++attempts >= 80) {
        settled = true;
        apiPromise = null;
        reject(new Error('YouTube API timed out'));
        return;
      }
      setTimeout(check, 100);
    };
    check();
  });
  return apiPromise;
}

async function startPlayer() {
  if (!host || !eligible || role !== 'observer' || starting || player
    || performance.now() < retryAtMs) return;
  startAttempts++;
  starting = true;
  const ownGeneration = ++generation;
  readyTimer = setTimeout(() => {
    if (ownGeneration === generation && !playerReady) failInitialization();
  }, 10_000);
  setStatus('choir.followerLoading');
  try {
    const YT = await loadYouTubeAPI();
    const room = currentRoom();
    if (!eligible || role !== 'observer' || ownGeneration !== generation || !room) {
      if (ownGeneration === generation) {
        clearTimeout(readyTimer);
        readyTimer = null;
        starting = false;
      }
      return;
    }
    const mount = document.createElement('div');
    host.replaceChildren(mount);
    // Created with the room's video, as the main Song player is: on iPhone a
    // player made without one fails with error 2 (invalid parameter) and
    // never plays. origin is the page's, again as the main player.
    localVideoId = room.videoId;
    lastSeekAtMs = performance.now();
    player = new YT.Player(mount, {
      width: '320', height: '180',
      videoId: room.videoId,
      playerVars: {
        playsinline: 1, controls: 1, rel: 0, origin: location.origin,
        start: Math.floor(room.positionSeconds),
      },
      events: {
        onReady: () => {
          if (ownGeneration !== generation) return;
          clearTimeout(readyTimer);
          readyTimer = null;
          playerReady = true;
          starting = false;
          startAttempts = 0;
          try { player.mute(); } catch { soundState = 'audible'; }
          tick();
        },
        onAutoplayBlocked: () => {
          if (ownGeneration !== generation) return;
          setLocalPlayback(false);
          autoplayBlocked = true;
          setStatus('choir.followerTapPlay');
        },
        onStateChange: (event) => {
          if (ownGeneration !== generation) return;
          if (event.data === 1 && failedVideoId === latestRoom?.videoId) {
            try { player?.pauseVideo(); } catch {}
            return;
          }
          // Only ever turns Listen off here; tick() decides when it returns,
          // so a buffering or paused moment does not flip Listen back on.
          if (event.data === 1 && eligible && role === 'observer' && currentRoom()) setLocalPlayback(true);
          if (event.data === 1) {
            videoErrors = 0;
            autoplayBlocked = false;
            setStatus(soundState === 'tap-for-sound' ? tapSound : null);
          }
        },
        onError: (event) => {
          if (ownGeneration !== generation) return;
          lastErrorCode = Number.isFinite(Number(event?.data)) ? Number(event.data) : null;
          if (!playerReady) { failInitialization(); return; }
          setLocalPlayback(false);
          failedVideoId = localVideoId;
          // Often passing on a phone (5: the player broke, e.g. when the Mic
          // changed the audio route): a fresh player tries again, more slowly
          // each time, rather than leaving B songless for this video.
          videoErrors++;
          videoRetryAtMs = performance.now() + Math.min(15_000, 3_000 * videoErrors);
          setStatus('choir.followerVideoError');
          try { player?.pauseVideo(); } catch {}
        },
      },
    });
  } catch {
    if (ownGeneration !== generation) return;
    failInitialization();
  }
}

/** What B's local player is doing, for the server log (a songless B is otherwise a guess). */
function playerMuted() {
  try { return player.isMuted() === true; } catch { return false; }
}
/**
 * Unmutes the playing song. WebKit pauses an unmute it does not count as a
 * tap: then it goes back to muted playback, so the song keeps time, and B is
 * asked for a tap (tapSoundKey says where).
 */
function tryUnmute(tapSoundKey) {
  soundState = 'unmuting';
  const ownGeneration = generation;
  try { player.unMute(); } catch {}
  try { player.playVideo(); } catch {}
  clearTimeout(unmuteTimer);
  unmuteTimer = setTimeout(() => {
    unmuteTimer = null;
    if (ownGeneration !== generation || soundState !== 'unmuting') return;
    // Buffering after a successful unmute is not an autoplay refusal.
    // Re-muting here forced an already audible B to ask for another tap.
    if (!playerMuted()) {
      soundState = 'audible';
      tick();
      return;
    }
    soundState = 'tap-for-sound';
    tapSound = tapSoundKey;
    try { player.mute(); } catch {}
    try { player.playVideo(); } catch {}
    tick();
  }, 400);
}
/** Once the muted song plays: turn it up, or ask for the tap the browser needs. */
function reconcileSound(playerState) {
  if (playerState !== 1) return;
  if (soundState === 'muted') tryUnmute('choir.followerTapSound');
  else if (soundState === 'tap-for-sound' && !playerMuted()) soundState = 'audible';
}

function publishReport() {
  let playerState = null;
  try { playerState = playerReady ? Number(player.getPlayerState()) : null; } catch {}
  window.dispatchEvent(new CustomEvent('relay-choir-follower-report', {
    detail: {
      eligible, role, playerReady, starting, playerState, startAttempts,
      autoplayBlocked, failedVideo: failedVideoId !== null, errorCode: lastErrorCode, videoErrors,
      status: statusKey, sound: soundState,
      localPlayback: localBackingAudibleRole, roomVideo: latestRoom?.videoId ?? null,
    },
  }));
}

function tick() {
  publishReport();
  if (!eligible || role !== 'observer') return;
  const room = currentRoom();
  if (!room) {
    setLocalPlayback(false);
    if (playerReady) try { player.pauseVideo(); } catch {}
    setStatus('choir.followerRoomStale');
    return;
  }
  if (failedVideoId === room.videoId) {
    if (performance.now() >= videoRetryAtMs) resetPlayer();
    else setStatus('choir.followerVideoError');
    return;
  }
  if (!playerReady) {
    if (!starting && !player) void startPlayer();
    return;
  }
  let local;
  let sampledAtPerformanceMs = 0;
  try {
    sampledAtPerformanceMs = performance.now();
    local = {
      ready: true,
      videoId: localVideoId,
      positionSeconds: Number(player.getCurrentTime()),
      playbackRate: Number(player.getPlaybackRate()),
      playerState: Number(player.getPlayerState()),
      rateAttempted: attemptedRate === room.playbackRate,
    };
  } catch {
    setStatus('choir.followerLoading');
    return;
  }
  // Listen yields while the local song is starting, not only once it plays:
  // on iOS, Listen sounding again on every buffering or paused moment
  // interrupts the video that is trying to start. It returns on failure, and
  // once the local song has not played for LOCAL_START_GRACE_MS: a player stuck
  // buffering without an error must not leave B with no song at all.
  if (!room.playing || local.playerState === 1) localNotPlayingSinceMs = null;
  else if (localNotPlayingSinceMs === null) localNotPlayingSinceMs = sampledAtPerformanceMs;
  const localStuck = localNotPlayingSinceMs !== null
    && sampledAtPerformanceMs - localNotPlayingSinceMs >= LOCAL_START_GRACE_MS;
  setLocalPlayback((room.playing && !autoplayBlocked && !localStuck) || local.playerState === 1);
  reconcileSound(local.playerState);
  if (local.playerState === 1 && localVideoId === room.videoId) {
    // Where B's local YouTube is, for B's YouTube-time alignment.
    window.dispatchEvent(new CustomEvent('relay-choir-song-anchor', {
      detail: {
        videoId: localVideoId, state: 1, currentTime: local.positionSeconds,
        playbackRate: local.playbackRate, sampledAtPerformanceMs,
      },
    }));
  }
  const nowMs = performance.now();
  const action = decideFollowerAction(room, local, nowMs, lastSeekAtMs);
  try {
    switch (action.type) {
      case 'cue':
        attemptedRate = null;
        setLocalPlayback(false);
        // A new video starts with a fresh grace for Listen to yield.
        localNotPlayingSinceMs = null;
        localVideoId = action.videoId;
        lastSeekAtMs = nowMs;
        player.cueVideoById({ videoId: action.videoId, startSeconds: action.positionSeconds });
        break;
      case 'pause':
        player.pauseVideo();
        break;
      case 'rate':
        // A refused/unsupported rate must not starve play or seek forever.
        attemptedRate = action.playbackRate;
        try { player.setPlaybackRate(action.playbackRate); } catch {}
        break;
      case 'seek':
        lastSeekAtMs = nowMs;
        player.seekTo(action.positionSeconds, true);
        break;
      case 'play':
        if (nowMs - lastPlayAttemptMs >= 5_000) {
          lastPlayAttemptMs = nowMs;
          player.playVideo();
        }
        break;
      default:
        break;
    }
  } catch {
    setLocalPlayback(false);
    try { player?.pauseVideo(); } catch {}
    setStatus('choir.followerVideoError');
    return;
  }
  if (room.playing && local.playerState === 1 && soundState === 'tap-for-sound') {
    autoplayBlocked = false;
    setStatus(tapSound);
  } else if (!room.playing || local.playerState === 1) {
    autoplayBlocked = false;
    setStatus(null);
  } else if (autoplayBlocked || (localVideoId === room.videoId
    && lastPlayAttemptMs > Number.NEGATIVE_INFINITY
    && nowMs - lastPlayAttemptMs >= 2_500 && local.playerState !== 3)) {
    // Only ask for a manual tap when autoplay has actually failed.
    setStatus('choir.followerTapPlay');
  } else if (local.playerState === 3) {
    setStatus('choir.followerLoading');
  }
  if (positionNode) {
    // Main Song UI shows current / duration, exactly like the N=1 player.
    // Room-versus-local drift belongs in diagnostics, not the singer's Song row.
    positionNode.textContent = formatTime(local.positionSeconds)
      + ' / ' + formatTime(room.durationSeconds);
  }
}

// A tap on the page, which iOS may count for the song's sound.
unmuteButton?.addEventListener('click', () => {
  if (!playerReady || soundState !== 'tap-for-sound') return;
  tryUnmute('choir.followerTapVideo');
});
window.addEventListener('relay-request-choir-local-playback', () => {
  window.dispatchEvent(new CustomEvent('relay-choir-local-playback', {
    detail: { active: localBackingAudibleRole },
  }));
});
window.addEventListener('relay-choir-guest-state', (event) => {
  eligible = event.detail?.enabled === true;
  showFollower();
});
window.addEventListener('relay:playback-view', (event) => {
  role = event.detail?.role ?? 'connecting';
  latestRoom = event.detail?.room ?? null;
  roomReceivedAtMs = event.detail?.roomReceivedAtMs ?? null;
  showFollower();
  tick();
});
window.addEventListener('relay-locale-changed', () => {
  const previous = statusKey;
  statusKey = null;
  setStatus(previous);
});
window.addEventListener('pagehide', () => {
  resetPlayer();
});
if (stage && host && positionNode && statusNode) {
  host.hidden = true;
  positionNode.hidden = true;
  statusNode.hidden = true;
  if (unmuteButton) unmuteButton.hidden = true;
  setInterval(tick, 500);
  window.dispatchEvent(new Event('relay-request-choir-guest-state'));
}
