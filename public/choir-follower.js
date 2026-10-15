import { projectFollowerRoom, decideFollowerAction } from './choir-follower-clock.js';

// Separate, default-off YouTube iframe. Never reuses the N=1 room-song player.
const panel = document.querySelector('#choir-follower-panel');
const startButton = document.querySelector('#choir-follower-start');
const playerHost = document.querySelector('#choir-follower-player');
const statusNode = document.querySelector('#choir-follower-status');
const positionNode = document.querySelector('#choir-follower-position');
const micNode = document.querySelector('#choir-follower-mic');
const t = (key) => window.relayI18n?.t(key) ?? key;

let eligible = false;
let role = 'connecting';
let latestRoom = null;
let roomReceivedAtMs = null;
let player = null;
let playerReady = false;
let userEnabled = false;
let localVideoId = null;
let failedVideoId = null;
let lastSeekAtMs = Number.NEGATIVE_INFINITY;
let generation = 0;
let apiPromise = null;
let micConnected = false;
let lastStatusKey = 'choir.followerInactive';

function setStatus(key) {
  lastStatusKey = key;
  if (statusNode) statusNode.textContent = t(key);
}
function formatTime(value) {
  if (!Number.isFinite(value) || value < 0) return '--:--';
  const seconds = Math.floor(value);
  return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
}
function resetPlayer() {
  generation++;
  try { player?.pauseVideo(); } catch {}
  try { player?.destroy(); } catch {}
  player = null;
  playerReady = false;
  userEnabled = false;
  localVideoId = null;
  failedVideoId = null;
  lastSeekAtMs = Number.NEGATIVE_INFINITY;
  if (playerHost) playerHost.replaceChildren();
  if (positionNode) positionNode.textContent = '--:-- / --:--';
}
function renderAvailability() {
  if (!panel) return;
  const visible = eligible && role === 'observer';
  panel.hidden = !visible;
  if (!visible) {
    if (player || userEnabled) resetPlayer();
    setStatus('choir.followerInactive');
    return;
  }
  startButton.hidden = userEnabled;
  startButton.disabled = !currentRoom();
  if (micNode) micNode.textContent = t(micConnected
    ? 'choir.followerMicConnected' : 'choir.followerMicPending');
  if (!userEnabled) setStatus('choir.followerPrompt');
}
function loadYouTubeAPI() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    let settled = false;
    const finish = () => {
      if (settled) return;
      if (!window.YT?.Player) return;
      settled = true;
      resolve(window.YT);
    };
    window.onYouTubeIframeAPIReady = () => {
      try { previous?.(); } finally { finish(); }
    };
    const existing = document.querySelector('script[src*="youtube.com/iframe_api"]');
    if (!existing) {
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.addEventListener('error', () => {
        if (!settled) { settled = true; apiPromise = null; reject(new Error('YouTube API failed')); }
      }, { once: true });
      document.head.append(script);
    }
    // Another Relay component may already be loading the API.
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

function currentRoom() {
  return projectFollowerRoom(latestRoom, roomReceivedAtMs, performance.now());
}
function tick() {
  if (!eligible || role !== 'observer' || !userEnabled) return;
  const room = currentRoom();
  if (!room) {
    if (playerReady) {
      try { player.pauseVideo(); } catch {}
    }
    setStatus('choir.followerRoomStale');
    return;
  }
  if (failedVideoId === room.videoId) {
    setStatus('choir.followerVideoError');
    return;
  }
  if (!playerReady) {
    setStatus('choir.followerLoading');
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
        setStatus('choir.followerCued');
        break;
      case 'pause':
        player.pauseVideo();
        setStatus('choir.followerPaused');
        break;
      case 'rate':
        player.setPlaybackRate(action.playbackRate);
        break;
      case 'seek':
        lastSeekAtMs = nowMs;
        player.seekTo(action.positionSeconds, true);
        break;
      case 'play':
        player.playVideo();
        break;
      default:
        break;
    }
  } catch {
    setStatus('choir.followerVideoError');
  }
  if (action.type !== 'cue' && action.type !== 'pause') {
    // A successful playVideo() call is NOT evidence that mobile autoplay worked.
    setStatus(!room.playing ? 'choir.followerPaused'
      : local.playerState === 1 ? 'choir.followerFollowing'
      : local.playerState === 3 ? 'choir.followerLoading'
      : 'choir.followerTapPlay');
  }
  if (positionNode) {
    positionNode.textContent = formatTime(local.positionSeconds)
      + ' / ' + formatTime(room.positionSeconds);
  }
}

startButton?.addEventListener('click', async () => {
  if (!eligible || role !== 'observer' || userEnabled || !currentRoom()) return;
  // A direct B user gesture is mandatory; consent alone must never autoplay.
  userEnabled = true;
  const ownGeneration = ++generation;
  renderAvailability();
  setStatus('choir.followerLoading');
  try {
    const YT = await loadYouTubeAPI();
    if (!eligible || role !== 'observer' || ownGeneration !== generation) return;
    const mount = document.createElement('div');
    playerHost.replaceChildren(mount);
    player = new YT.Player(mount, {
      width: '320', height: '180',
      playerVars: { playsinline: 1, controls: 1, rel: 0, enablejsapi: 1 },
      events: {
        onReady: () => {
          if (ownGeneration !== generation) return;
          playerReady = true;
          setStatus('choir.followerTapPlay');
          tick();
        },
        onError: () => {
          failedVideoId = localVideoId;
          setStatus('choir.followerVideoError');
          try { player?.pauseVideo(); } catch {}
        },
      },
    });
  } catch {
    if (ownGeneration !== generation) return;
    resetPlayer();
    renderAvailability();
    setStatus('choir.followerVideoError');
  }
});

window.addEventListener('relay-choir-guest-state', (event) => {
  const allowed = event.detail?.enabled === true;
  if (!allowed && eligible) resetPlayer();
  eligible = allowed;
  renderAvailability();
});
window.addEventListener('relay:playback-view', (event) => {
  role = event.detail?.role ?? 'connecting';
  latestRoom = event.detail?.room ?? null;
  roomReceivedAtMs = event.detail?.roomReceivedAtMs ?? null;
  renderAvailability();
  tick();
});
window.addEventListener('relay-choir-media-connection', (event) => {
  micConnected = eligible && event.detail?.state === 'registered';
  renderAvailability();
});
window.addEventListener('relay-locale-changed', () => {
  renderAvailability();
  if (userEnabled) setStatus(lastStatusKey);
});
window.addEventListener('pagehide', resetPlayer);
if (panel && startButton && playerHost) {
  panel.hidden = true;
  setInterval(tick, 500);
  window.dispatchEvent(new Event('relay-request-choir-guest-state'));
}
