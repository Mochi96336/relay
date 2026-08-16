const input = document.querySelector('#youtube-url');
const loadButton = document.querySelector('#load-youtube');
const stateNode = document.querySelector('#youtube-state');
const timelineNode = document.querySelector('#youtube-timeline');
const noteNode = document.querySelector('#youtube-note');

const STATE_NAMES = new Map([
  [-1, 'unstarted'],
  [0, 'ended'],
  [1, 'playing'],
  [2, 'paused'],
  [3, 'buffering'],
  [5, 'cued'],
]);

const ERROR_NAMES = new Map([
  [2, 'invalid video ID'],
  [5, 'HTML5 playback error'],
  [100, 'video unavailable'],
  [101, 'embedding disabled by owner'],
  [150, 'embedding disabled by owner'],
  [153, 'missing Referer / client identity'],
]);

let player = null;
let playerReady = false;
let loadedVideoId = null;
let telemetryTimer = null;
let previousSnapshot = null;
let apiPromise = null;
let pendingHandoff = null;
let handoffReadySent = false;
let handoffReadyTimers = [];

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const remainder = whole % 60;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function parseVideoId(rawValue) {
  const value = rawValue.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(value)) return value;

  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  let candidate = null;

  if (host === 'youtu.be') {
    candidate = url.pathname.split('/').filter(Boolean)[0] ?? null;
  } else if (
    host === 'youtube.com' ||
    host === 'm.youtube.com' ||
    host === 'music.youtube.com' ||
    host === 'youtube-nocookie.com'
  ) {
    if (url.pathname === '/watch') {
      candidate = url.searchParams.get('v');
    } else {
      const [kind, id] = url.pathname.split('/').filter(Boolean);
      if (['embed', 'shorts', 'live'].includes(kind)) candidate = id ?? null;
    }
  }

  return candidate && /^[A-Za-z0-9_-]{11}$/.test(candidate) ? candidate : null;
}

function loadYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;

  apiPromise = new Promise((resolve, reject) => {
    const previousReady = window.onYouTubeIframeAPIReady;
    let script = null;

    /**
     * A failed attempt has to leave nothing behind.
     *
     * The memoized promise and the injected <script> are both guards against
     * loading the API twice, so either one surviving a failure makes the
     * failure permanent: the promise is handed to every later caller already
     * rejected, and the tag makes a retry wait on a callback that has no
     * script left to fire it. On the robot that turns a temporary outage -
     * booting before the network is up - into a page that cannot load a song
     * again until someone reloads it, which nobody is there to do.
     */
    const fail = (error) => {
      clearTimeout(timeout);
      window.onYouTubeIframeAPIReady = previousReady;
      apiPromise = null;
      script?.remove();
      reject(error);
    };

    const timeout = setTimeout(() => fail(new Error('YouTube IFrame API timed out.')), 15_000);

    window.onYouTubeIframeAPIReady = () => {
      clearTimeout(timeout);
      previousReady?.();
      resolve(window.YT);
    };

    script = document.querySelector('script[data-relay-youtube-api]');
    if (!script) {
      script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.async = true;
      script.dataset.relayYoutubeApi = 'true';
      script.addEventListener('error', () => {
        fail(new Error('Could not load YouTube IFrame API.'));
      }, { once: true });
      document.head.append(script);
    }
  });

  return apiPromise;
}

function setPlayerState(state, detail = '') {
  const label = STATE_NAMES.get(state) ?? `state ${state}`;
  stateNode.textContent = detail ? `${label} · ${detail}` : label;
}

function readSnapshot() {
  if (!playerReady || !player || !loadedVideoId) return null;

  const now = performance.now();
  const state = Number(player.getPlayerState());
  const currentTime = Number(player.getCurrentTime());
  const duration = Number(player.getDuration());
  const playbackRate = Number(player.getPlaybackRate());
  const bufferedFraction = Number(player.getVideoLoadedFraction());

  let timelineDeltaSeconds = 0;
  if (previousSnapshot && previousSnapshot.state === 1 && state === 1) {
    const elapsedSeconds = (now - previousSnapshot.sampledAtPerformanceMs) / 1000;
    const expected = previousSnapshot.currentTime + elapsedSeconds * previousSnapshot.playbackRate;
    timelineDeltaSeconds = currentTime - expected;
  }

  const snapshot = {
    videoId: loadedVideoId,
    state,
    currentTime,
    duration,
    playbackRate,
    bufferedFraction,
    sampledAtMs: performance.timeOrigin + now,
    sampledAtPerformanceMs: now,
    timelineDeltaSeconds,
  };

  previousSnapshot = snapshot;
  return snapshot;
}

function renderSnapshot(snapshot) {
  if (!snapshot) return;

  const buffered = Number.isFinite(snapshot.bufferedFraction)
    ? `${Math.round(snapshot.bufferedFraction * 100)}% buffered`
    : 'buffer --';

  timelineNode.textContent = `${formatTime(snapshot.currentTime)} / ${formatTime(snapshot.duration)} · ${snapshot.playbackRate || 1}× · ${buffered}`;

  if (Math.abs(snapshot.timelineDeltaSeconds) > 0.4) {
    const sign = snapshot.timelineDeltaSeconds > 0 ? '+' : '';
    noteNode.textContent = `Timeline jump detected: ${sign}${snapshot.timelineDeltaSeconds.toFixed(2)} s. This is expected after seeks or some playback interruptions.`;
  } else if (snapshot.state === 3) {
    noteNode.textContent = 'YouTube is buffering. Mic transport can keep running independently.';
  } else if (!pendingHandoff) {
    noteNode.textContent = 'Timeline is media time from the YouTube player; it does not include the phone speaker/headphone output latency.';
  }

  window.dispatchEvent(new CustomEvent('relay:youtube-telemetry', {
    detail: {
      videoId: snapshot.videoId,
      state: snapshot.state,
      currentTime: snapshot.currentTime,
      duration: snapshot.duration,
      playbackRate: snapshot.playbackRate,
      bufferedFraction: snapshot.bufferedFraction,
      sampledAtMs: snapshot.sampledAtMs,
      timelineDeltaSeconds: snapshot.timelineDeltaSeconds,
    },
  }));
}

function sampleNow() {
  const snapshot = readSnapshot();
  if (!snapshot) return;
  setPlayerState(snapshot.state);
  renderSnapshot(snapshot);
}

function startTelemetry() {
  if (telemetryTimer) clearInterval(telemetryTimer);
  sampleNow();
  telemetryTimer = setInterval(sampleNow, 250);
}

function clearHandoffReadyTimers() {
  for (const timer of handoffReadyTimers) clearTimeout(timer);
  handoffReadyTimers = [];
}

function actualVideoId() {
  try {
    const value = player?.getVideoData?.()?.video_id;
    return typeof value === 'string' && value ? value : loadedVideoId;
  } catch {
    return loadedVideoId;
  }
}

function announceHandoffReady() {
  if (!pendingHandoff || pendingHandoff.phase !== 'preparing' || handoffReadySent) return false;
  if (!playerReady || !player || actualVideoId() !== pendingHandoff.videoId) return false;

  const state = Number(player.getPlayerState());
  if (![1, 2, 5].includes(state)) return false;

  handoffReadySent = true;
  clearHandoffReadyTimers();
  noteNode.textContent = 'Room song is prepared on this device. Relay is waiting to switch playback safely.';
  window.dispatchEvent(new CustomEvent('relay:song-handoff-ready', {
    detail: { handoffId: pendingHandoff.handoffId },
  }));
  return true;
}

function scheduleHandoffReadyChecks() {
  clearHandoffReadyTimers();
  for (const delayMs of [80, 220, 500, 900, 1_500, 2_400]) {
    handoffReadyTimers.push(setTimeout(announceHandoffReady, delayMs));
  }
}

function cuePendingHandoff() {
  if (!pendingHandoff || !playerReady || !player) return;
  try {
    loadedVideoId = pendingHandoff.videoId;
    previousSnapshot = null;
    player.cueVideoById({
      videoId: pendingHandoff.videoId,
      startSeconds: Math.max(0, pendingHandoff.targetTime),
    });
    scheduleHandoffReadyChecks();
  } catch (error) {
    console.warn('Could not prepare room song handoff', error);
    window.dispatchEvent(new CustomEvent('relay:song-handoff-failed', {
      detail: {
        handoffId: pendingHandoff.handoffId,
        reason: 'prepare-failed',
      },
    }));
  }
}

function handleReady(event) {
  playerReady = true;
  const iframe = event.target.getIframe();
  iframe.referrerPolicy = 'strict-origin-when-cross-origin';
  setPlayerState(event.target.getPlayerState(), 'ready');
  startTelemetry();
  if (pendingHandoff?.phase === 'preparing') cuePendingHandoff();
}

function handleStateChange(event) {
  setPlayerState(event.data);
  sampleNow();
  if (pendingHandoff?.phase === 'preparing') announceHandoffReady();
}

function handlePlaybackRateChange(event) {
  setPlayerState(player?.getPlayerState?.() ?? -1, `${event.data}×`);
  sampleNow();
}

function handleError(event) {
  const label = ERROR_NAMES.get(event.data) ?? `YouTube error ${event.data}`;
  setPlayerState(-1, label);
  noteNode.textContent = `Player error ${event.data}: ${label}.`;
  if (pendingHandoff) {
    window.dispatchEvent(new CustomEvent('relay:song-handoff-failed', {
      detail: {
        handoffId: pendingHandoff.handoffId,
        reason: `youtube-error-${event.data}`,
      },
    }));
  }
}

function handleAutoplayBlocked() {
  noteNode.textContent = pendingHandoff?.phase === 'committing'
    ? 'Browser blocked the playback handoff. Tap Play once in the visible YouTube player; Relay will retry without dropping the old playback first.'
    : 'Browser blocked scripted playback. Tap Play directly inside the visible YouTube player.';

  if (pendingHandoff?.phase === 'committing') {
    const handoffId = pendingHandoff.handoffId;
    pendingHandoff.phase = 'preparing';
    handoffReadySent = false;
    window.dispatchEvent(new CustomEvent('relay:song-handoff-failed', {
      detail: { handoffId, reason: 'autoplay-blocked' },
    }));
  }
}

async function ensurePlayer(videoId) {
  const YT = await loadYouTubeApi();
  loadedVideoId = videoId;

  if (player) return player;

  player = new YT.Player('youtube-player', {
    width: 640,
    height: 360,
    videoId,
    playerVars: {
      playsinline: 1,
      origin: location.origin,
    },
    events: {
      onReady: handleReady,
      onStateChange: handleStateChange,
      onPlaybackRateChange: handlePlaybackRateChange,
      onError: handleError,
      onAutoplayBlocked: handleAutoplayBlocked,
    },
  });
  return player;
}

async function prepareRoomSong(message) {
  const handoffId = typeof message.handoffId === 'string' ? message.handoffId : null;
  const videoId = typeof message.videoId === 'string' && /^[A-Za-z0-9_-]{11}$/.test(message.videoId)
    ? message.videoId
    : null;
  const targetTime = Number(message.serverTime);
  if (!handoffId || !videoId || !Number.isFinite(targetTime)) return;

  pendingHandoff = {
    handoffId,
    videoId,
    targetTime: Math.max(0, targetTime),
    desiredState: Number(message.state),
    phase: 'preparing',
  };
  handoffReadySent = false;
  previousSnapshot = null;
  noteNode.textContent = 'Preparing the room song for microphone handoff. Playback will not start until the server commits the switch.';

  try {
    await ensurePlayer(videoId);
    if (playerReady) cuePendingHandoff();
  } catch (error) {
    console.error(error);
    window.dispatchEvent(new CustomEvent('relay:song-handoff-failed', {
      detail: { handoffId, reason: 'player-unavailable' },
    }));
  }
}

function commitRoomSong(message) {
  if (!pendingHandoff || message.handoffId !== pendingHandoff.handoffId) return;
  if (!playerReady || !player) {
    window.dispatchEvent(new CustomEvent('relay:song-handoff-failed', {
      detail: { handoffId: pendingHandoff.handoffId, reason: 'player-not-ready' },
    }));
    return;
  }

  const targetTime = Number(message.serverTime);
  const desiredState = Number(message.state);
  if (!Number.isFinite(targetTime)) return;

  pendingHandoff.phase = 'committing';
  pendingHandoff.targetTime = Math.max(0, targetTime);
  pendingHandoff.desiredState = desiredState;
  previousSnapshot = null;

  try {
    if (actualVideoId() !== pendingHandoff.videoId) {
      player.cueVideoById({
        videoId: pendingHandoff.videoId,
        startSeconds: pendingHandoff.targetTime,
      });
    }
    player.seekTo(pendingHandoff.targetTime, true);
    if (desiredState === 1) player.playVideo();
    else player.pauseVideo();
    setTimeout(sampleNow, 80);
    setTimeout(sampleNow, 220);
    noteNode.textContent = 'Switching room playback to this device…';
  } catch (error) {
    console.warn('Could not commit room song handoff', error);
    const handoffId = pendingHandoff.handoffId;
    pendingHandoff.phase = 'preparing';
    handoffReadySent = false;
    window.dispatchEvent(new CustomEvent('relay:song-handoff-failed', {
      detail: { handoffId, reason: 'commit-failed' },
    }));
  }
}

function releaseRoomSong(message) {
  if (!playerReady || !player) return;
  if (typeof message.videoId === 'string' && loadedVideoId !== message.videoId) return;

  try {
    player.pauseVideo();
  } catch {}
  noteNode.textContent = 'Room playback moved with the microphone. This player is no longer driving the shared song.';
}

/**
 * The server gave up waiting for this player to take over.
 *
 * Dropping the pending state matters as much as the note: a stale prepared
 * handoff would otherwise keep answering with a `handoffId` the server has
 * already forgotten.
 */
function cancelRoomSongHandoff() {
  if (!pendingHandoff) return;
  clearHandoffReadyTimers();
  pendingHandoff = null;
  handoffReadySent = false;
  noteNode.textContent = 'Room playback handoff was cancelled. Take the microphone again to retry.';
}

function completeRoomSong(message) {
  if (!pendingHandoff || message.handoffId !== pendingHandoff.handoffId) return;
  clearHandoffReadyTimers();
  pendingHandoff = null;
  handoffReadySent = false;
  noteNode.textContent = 'Room playback handoff complete. This device now follows the shared song.';
}

async function loadVideo() {
  const videoId = parseVideoId(input.value);
  if (!videoId) {
    stateNode.textContent = 'invalid URL / video ID';
    noteNode.textContent = 'Paste a YouTube watch, youtu.be, Shorts, Live, Embed URL, or an 11-character video ID.';
    return;
  }

  loadButton.disabled = true;
  stateNode.textContent = 'loading YouTube API…';
  noteNode.textContent = 'The video will be cued only. Start playback from the normal YouTube controls.';

  try {
    await ensurePlayer(videoId);
    loadedVideoId = videoId;
    previousSnapshot = null;

    if (playerReady) player.cueVideoById(videoId);
  } catch (error) {
    console.error(error);
    stateNode.textContent = 'could not load YouTube';
    noteNode.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    loadButton.disabled = false;
  }
}

window.addEventListener('relay:song-handoff-prepare', (event) => {
  prepareRoomSong(event.detail ?? {}).catch(console.error);
});
window.addEventListener('relay:song-handoff-commit', (event) => {
  commitRoomSong(event.detail ?? {});
});
window.addEventListener('relay:song-handoff-release', (event) => {
  releaseRoomSong(event.detail ?? {});
});
window.addEventListener('relay:song-handoff-complete', (event) => {
  completeRoomSong(event.detail ?? {});
});
window.addEventListener('relay:song-handoff-cancelled', () => {
  cancelRoomSongHandoff();
});

loadButton.addEventListener('click', () => {
  loadVideo().catch(console.error);
});

input.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  loadVideo().catch(console.error);
});

stateNode.textContent = 'not loaded';
timelineNode.textContent = '--:-- / --:--';
noteNode.textContent = 'Load a video, tap Play in the YouTube player, then start Microphone. The player stays visible and YouTube audio remains local to this device.';
