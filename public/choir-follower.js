import { projectFollowerRoom, decideFollowerAction } from './choir-follower-clock.js';

// B uses the EXISTING Song surface. This player never becomes the room leader,
// sends playback telemetry, or supplies a Mic acoustic calibration anchor.
const stage = document.querySelector('.song-stage');
const host = document.querySelector('#choir-follower-player');
const statusNode = document.querySelector('#choir-follower-status');
const positionNode = document.querySelector('#choir-follower-position');
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
let statusKey = null;

function setStatus(key) {
  if (statusKey === key) return;
  statusKey = key;
  if (statusNode) {
    statusNode.hidden = !key;
    statusNode.textContent = key ? t(key) : '';
  }
}
function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const value = Math.floor(seconds);
  return Math.floor(value / 60) + ':' + String(value % 60).padStart(2, '0');
}
function resetPlayer() {
  generation++;
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
  if (!host || !eligible || role !== 'observer' || starting || player) return;
  starting = true;
  const ownGeneration = ++generation;
  setStatus('choir.followerLoading');
  try {
    const YT = await loadYouTubeAPI();
    if (!eligible || role !== 'observer' || ownGeneration !== generation) return;
    const mount = document.createElement('div');
    host.replaceChildren(mount);
    player = new YT.Player(mount, {
      width: '320', height: '180',
      playerVars: { playsinline: 1, controls: 1, rel: 0, enablejsapi: 1 },
      events: {
        onReady: () => {
          if (ownGeneration !== generation) return;
          playerReady = true;
          starting = false;
          tick();
        },
        onAutoplayBlocked: () => {
          if (ownGeneration !== generation) return;
          autoplayBlocked = true;
          setStatus('choir.followerTapPlay');
        },
        onStateChange: (event) => {
          if (ownGeneration !== generation) return;
          if (event.data === 1) {
            autoplayBlocked = false;
            setStatus(null);
          }
        },
        onError: () => {
          if (ownGeneration !== generation) return;
          failedVideoId = localVideoId;
          setStatus('choir.followerVideoError');
          try { player?.pauseVideo(); } catch {}
        },
      },
    });
  } catch {
    if (ownGeneration !== generation) return;
    resetPlayer();
    setStatus('choir.followerVideoError');
  }
}

function tick() {
  if (!eligible || role !== 'observer') return;
  const room = currentRoom();
  if (!room) {
    if (playerReady) try { player.pauseVideo(); } catch {}
    setStatus('choir.followerRoomStale');
    return;
  }
  if (failedVideoId === room.videoId) {
    setStatus('choir.followerVideoError');
    return;
  }
  if (!playerReady) {
    if (!starting && !player) void startPlayer();
    return;
  }
  let local;
  try {
    local = {
      ready: true,
      videoId: localVideoId,
      positionSeconds: Number(player.getCurrentTime()),
      playbackRate: Number(player.getPlaybackRate()),
      playerState: Number(player.getPlayerState()),
    };
  } catch {
    setStatus('choir.followerLoading');
    return;
  }
  const nowMs = performance.now();
  const action = decideFollowerAction(room, local, nowMs, lastSeekAtMs);
  try {
    switch (action.type) {
      case 'cue':
        localVideoId = action.videoId;
        lastSeekAtMs = nowMs;
        player.cueVideoById({ videoId: action.videoId, startSeconds: action.positionSeconds });
        break;
      case 'pause':
        player.pauseVideo();
        break;
      case 'rate':
        player.setPlaybackRate(action.playbackRate);
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
    setStatus('choir.followerVideoError');
    return;
  }
  if (!room.playing || local.playerState === 1) {
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
    positionNode.textContent = formatTime(local.positionSeconds)
      + ' / ' + formatTime(room.positionSeconds);
  }
}

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
window.addEventListener('pagehide', resetPlayer);
if (stage && host && positionNode && statusNode) {
  host.hidden = true;
  positionNode.hidden = true;
  statusNode.hidden = true;
  setInterval(tick, 500);
  window.dispatchEvent(new Event('relay-request-choir-guest-state'));
}
