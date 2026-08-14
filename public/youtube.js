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
    const timeout = setTimeout(() => reject(new Error('YouTube IFrame API timed out.')), 15_000);
    const previousReady = window.onYouTubeIframeAPIReady;

    window.onYouTubeIframeAPIReady = () => {
      clearTimeout(timeout);
      previousReady?.();
      resolve(window.YT);
    };

    if (!document.querySelector('script[data-relay-youtube-api]')) {
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.async = true;
      script.dataset.relayYoutubeApi = 'true';
      script.addEventListener('error', () => {
        clearTimeout(timeout);
        reject(new Error('Could not load YouTube IFrame API.'));
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
  } else {
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

function handleReady(event) {
  playerReady = true;
  const iframe = event.target.getIframe();
  iframe.referrerPolicy = 'strict-origin-when-cross-origin';
  setPlayerState(event.target.getPlayerState(), 'ready');
  startTelemetry();
}

function handleStateChange(event) {
  setPlayerState(event.data);
  sampleNow();
}

function handlePlaybackRateChange(event) {
  setPlayerState(player?.getPlayerState?.() ?? -1, `${event.data}×`);
  sampleNow();
}

function handleError(event) {
  const label = ERROR_NAMES.get(event.data) ?? `YouTube error ${event.data}`;
  setPlayerState(-1, label);
  noteNode.textContent = `Player error ${event.data}: ${label}.`;
}

function handleAutoplayBlocked() {
  noteNode.textContent = 'Browser blocked scripted playback. Tap Play directly inside the visible YouTube player.';
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
    const YT = await loadYouTubeApi();
    loadedVideoId = videoId;
    previousSnapshot = null;

    if (player) {
      player.cueVideoById(videoId);
      return;
    }

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
  } catch (error) {
    console.error(error);
    stateNode.textContent = 'could not load YouTube';
    noteNode.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    loadButton.disabled = false;
  }
}

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
