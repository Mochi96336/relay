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
let localCommandPending = null;
let serverMutation = null;

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

function actualVideoId() {
  try {
    const value = player?.getVideoData?.()?.video_id;
    return typeof value === 'string' && value ? value : loadedVideoId;
  } catch {
    return loadedVideoId;
  }
}

function readSnapshot() {
  if (!playerReady || !player || !loadedVideoId) return null;

  const now = performance.now();
  const previous = previousSnapshot;
  const state = Number(player.getPlayerState());
  const currentTime = Number(player.getCurrentTime());
  const duration = Number(player.getDuration());
  const playbackRate = Number(player.getPlaybackRate());
  const bufferedFraction = Number(player.getVideoLoadedFraction());
  const currentVideoId = actualVideoId() ?? loadedVideoId;
  if (currentVideoId) loadedVideoId = currentVideoId;

  let timelineDeltaSeconds = 0;
  if (previous && previous.videoId === currentVideoId) {
    const elapsedSeconds = (now - previous.sampledAtPerformanceMs) / 1000;
    const expected = previous.state === 1 && state === 1
      ? previous.currentTime + elapsedSeconds * previous.playbackRate
      : previous.currentTime;
    timelineDeltaSeconds = currentTime - expected;
  }

  const snapshot = {
    videoId: currentVideoId,
    state,
    currentTime,
    duration,
    playbackRate,
    bufferedFraction,
    sampledAtMs: performance.timeOrigin + now,
    sampledAtPerformanceMs: now,
    timelineDeltaSeconds,
    previousVideoId: previous?.videoId ?? null,
    previousState: previous?.state ?? null,
    previousPlaybackRate: previous?.playbackRate ?? null,
  };

  previousSnapshot = snapshot;
  return snapshot;
}

function activeServerMutation() {
  if (!serverMutation) return null;
  // A room command stays active until the server proves completion/failure or
  // reports that no command is pending. Local timeouts would otherwise erase
  // the recovery identity before the authoritative command timeout lands.
  if (serverMutation.source === 'room-command') return serverMutation;
  if (performance.now() <= serverMutation.expiresAt) return serverMutation;
  serverMutation = null;
  return null;
}

function requestRoomSongCommand(detail) {
  // Phase 1B deliberately replaces the page's previous local intent. The sync
  // transport attaches the predecessor command id synchronously, so another
  // gesture can causally supersede this one before either server round trip
  // finishes.
  localCommandPending = {
    action: detail.action,
    commandId: null,
    requestedAt: performance.now(),
  };
  noteNode.textContent = `Requesting room ${detail.action}…`;
  window.dispatchEvent(new CustomEvent('relay:room-song-command-intent', { detail }));
  return true;
}

function normalizedDesiredState(value) {
  const desired = value && typeof value === 'object' ? value : null;
  if (!desired) return null;
  const videoId = typeof desired.videoId === 'string' && /^[A-Za-z0-9_-]{11}$/.test(desired.videoId)
    ? desired.videoId
    : null;
  const positionSeconds = Number(desired.positionSeconds);
  const state = Number(desired.state);
  const playbackRate = Number(desired.playbackRate);
  if (
    !videoId
    || !Number.isFinite(positionSeconds)
    || positionSeconds < 0
    || ![1, 2, 5].includes(state)
    || !Number.isFinite(playbackRate)
    || playbackRate <= 0
  ) return null;
  return { videoId, positionSeconds, state, playbackRate };
}

function projectedDesiredPosition(mutation, now = performance.now()) {
  if (!mutation?.desired) return null;
  const elapsedSeconds = mutation.desired.state === 1
    ? Math.max(0, now - mutation.appliedAtPerformanceMs) / 1000
    : 0;
  return mutation.desired.positionSeconds + elapsedSeconds * mutation.desired.playbackRate;
}

function snapshotMatchesDesired(snapshot, mutation) {
  if (!snapshot || !mutation?.desired) return false;
  const desired = mutation.desired;
  if (snapshot.videoId !== desired.videoId) return false;
  if (Math.abs(snapshot.playbackRate - desired.playbackRate) > 0.0001) return false;

  const desiredPosition = projectedDesiredPosition(mutation, snapshot.sampledAtPerformanceMs);
  if (!Number.isFinite(desiredPosition) || Math.abs(snapshot.currentTime - desiredPosition) > 1.5) return false;

  if (desired.state === 1) return snapshot.state === 1 || snapshot.state === 3;
  if (desired.state === 2) return snapshot.state === 2;
  return snapshot.state === 5 || snapshot.state === 2 || snapshot.state === -1;
}

function localMutationForSnapshot(snapshot) {
  if (!snapshot || !snapshot.previousVideoId) return null;
  if (pendingHandoff) return null;

  const mutationContext = activeServerMutation();
  if (mutationContext && mutationContext.source !== 'room-command') return null;

  // Server apply itself is not a new product intent. If the player has reached
  // the latest complete desired state, report proof instead of recursively
  // turning that state transition into another command. A later deviation from
  // that desired state is a genuine user gesture and may supersede it.
  if (mutationContext?.source === 'room-command' && snapshotMatchesDesired(snapshot, mutationContext)) {
    return null;
  }

  if (snapshot.videoId !== snapshot.previousVideoId) {
    return { action: 'load', videoId: snapshot.videoId, positionSeconds: Math.max(0, snapshot.currentTime) };
  }

  if (
    Number.isFinite(snapshot.previousPlaybackRate)
    && Number.isFinite(snapshot.playbackRate)
    && Math.abs(snapshot.playbackRate - snapshot.previousPlaybackRate) > 0.0001
  ) {
    return { action: 'rate', playbackRate: snapshot.playbackRate };
  }

  if (snapshot.state !== snapshot.previousState) {
    if (snapshot.state === 1 && ![1, 3].includes(snapshot.previousState)) {
      return { action: 'play' };
    }
    if (snapshot.state === 2 && snapshot.previousState !== 2) {
      return { action: 'pause' };
    }
  }

  if (Math.abs(snapshot.timelineDeltaSeconds) > 0.75) {
    return { action: 'seek', positionSeconds: Math.max(0, snapshot.currentTime) };
  }

  return null;
}

function renderSnapshot(snapshot) {
  if (!snapshot) return;

  const buffered = Number.isFinite(snapshot.bufferedFraction)
    ? `${Math.round(snapshot.bufferedFraction * 100)}% buffered`
    : 'buffer --';

  timelineNode.textContent = `${formatTime(snapshot.currentTime)} / ${formatTime(snapshot.duration)} · ${snapshot.playbackRate || 1}× · ${buffered}`;

  if (Math.abs(snapshot.timelineDeltaSeconds) > 0.4) {
    const sign = snapshot.timelineDeltaSeconds > 0 ? '+' : '';
    noteNode.textContent = `Timeline jump detected: ${sign}${snapshot.timelineDeltaSeconds.toFixed(2)} s.`;
  } else if (snapshot.state === 3) {
    noteNode.textContent = 'YouTube is buffering. Mic transport can keep running independently.';
  } else if (!pendingHandoff && !localCommandPending && !activeServerMutation()) {
    noteNode.textContent = 'Timeline is media time from the YouTube player; shared controls are authorized by Relay.';
  }

  // During preparation the target player is deliberately being cued before it
  // owns the room clock. Do not turn that local preparation into product input.
  if (pendingHandoff?.phase === 'preparing') return;

  // Detect a newer native control gesture even while an earlier command is
  // awaiting acceptance/proof. Stable intermediate telemetry stays suppressed
  // until the latest local intent has a server apply.
  const mutation = localMutationForSnapshot(snapshot);
  if (mutation) {
    requestRoomSongCommand(mutation);
    return;
  }
  if (localCommandPending) return;

  const mutationContext = activeServerMutation();
  if (mutationContext?.suppressTelemetry) return;

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
    serverMutation = {
      source: 'handoff-prepare',
      action: 'load',
      suppressTelemetry: true,
      expiresAt: performance.now() + 3_000,
    };
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
  if (serverMutation?.source === 'room-command' && serverMutation.commandId) {
    window.dispatchEvent(new CustomEvent('relay:room-song-command-failed', {
      detail: {
        commandId: serverMutation.commandId,
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
    return;
  }

  if (serverMutation?.source === 'room-command' && serverMutation.desired?.state === 1) {
    const commandId = serverMutation.commandId;
    serverMutation = null;
    window.dispatchEvent(new CustomEvent('relay:room-song-command-failed', {
      detail: { commandId, reason: 'autoplay-blocked' },
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

async function applyRoomSongCommand(message) {
  const commandId = typeof message.commandId === 'string' ? message.commandId : null;
  const action = typeof message.action === 'string' ? message.action : null;
  const revision = Number(message.revision);
  const desired = normalizedDesiredState(message.desired);
  if (!commandId || !action || !Number.isSafeInteger(revision) || !desired) return;

  if (
    serverMutation?.source === 'room-command'
    && Number.isSafeInteger(serverMutation.revision)
    && serverMutation.revision > revision
  ) return;

  serverMutation = {
    source: 'room-command',
    commandId,
    revision,
    action,
    desired,
    appliedAtPerformanceMs: performance.now(),
    suppressTelemetry: false,
    expiresAt: Number.POSITIVE_INFINITY,
  };

  try {
    await ensurePlayer(desired.videoId);
    // A newer apply may have arrived while the YouTube API/player was loading.
    // Never let the older async continuation mutate playback afterward.
    if (serverMutation?.source !== 'room-command' || serverMutation.commandId !== commandId) return;
    if (!playerReady || !player) {
      if (desired.state === 5) {
        noteNode.textContent = `Preparing room ${action}…`;
        return;
      }
      throw new Error('player not ready');
    }

    previousSnapshot = null;
    loadedVideoId = desired.videoId;
    serverMutation.appliedAtPerformanceMs = performance.now();

    if (desired.state === 5) {
      player.cueVideoById({
        videoId: desired.videoId,
        startSeconds: Math.max(0, desired.positionSeconds),
      });
    } else {
      if (actualVideoId() !== desired.videoId) {
        player.cueVideoById({
          videoId: desired.videoId,
          startSeconds: Math.max(0, desired.positionSeconds),
        });
      }
      player.seekTo(Math.max(0, desired.positionSeconds), true);
      player.setPlaybackRate(desired.playbackRate);
      if (desired.state === 1) player.playVideo();
      else player.pauseVideo();
    }

    if (desired.state === 5) player.setPlaybackRate(desired.playbackRate);
    noteNode.textContent = `Applying latest room ${action}…`;
    setTimeout(() => {
      if (serverMutation?.commandId === commandId) sampleNow();
    }, 80);
    setTimeout(() => {
      if (serverMutation?.commandId === commandId) sampleNow();
    }, 220);
  } catch (error) {
    console.warn('Could not apply room song command', error);
    if (serverMutation?.commandId !== commandId) return;
    serverMutation = null;
    window.dispatchEvent(new CustomEvent('relay:room-song-command-failed', {
      detail: {
        commandId,
        reason: error instanceof Error ? error.message : 'apply-failed',
      },
    }));
  }
}

async function restoreAuthoritativeRoom(room) {
  if (!room || typeof room !== 'object') return;
  localCommandPending = null;

  const videoId = typeof room.videoId === 'string' ? room.videoId : null;
  if (!videoId) {
    if (playerReady && player) {
      serverMutation = {
        source: 'restore',
        action: 'pause',
        suppressTelemetry: true,
        expiresAt: performance.now() + 1_500,
      };
      try { player.pauseVideo(); } catch {}
    }
    return;
  }

  const targetTime = Number(room.serverTime);
  const desiredState = Number(room.state);
  const playbackRate = Number(room.playbackRate);

  try {
    serverMutation = {
      source: 'restore',
      action: 'restore',
      suppressTelemetry: false,
      expiresAt: performance.now() + 2_000,
    };
    await ensurePlayer(videoId);
    if (!playerReady || !player) return;

    if (actualVideoId() !== videoId) {
      loadedVideoId = videoId;
      previousSnapshot = null;
      player.cueVideoById({ videoId, startSeconds: Number.isFinite(targetTime) ? Math.max(0, targetTime) : 0 });
    }
    if (Number.isFinite(targetTime)) player.seekTo(Math.max(0, targetTime), true);
    if (Number.isFinite(playbackRate)) player.setPlaybackRate(playbackRate);
    if (desiredState === 1) player.playVideo();
    else if ([0, 2, 5].includes(desiredState)) player.pauseVideo();
    setTimeout(sampleNow, 100);
    setTimeout(sampleNow, 260);
  } catch (error) {
    console.warn('Could not restore authoritative room song', error);
  }
}

async function prepareRoomSong(message) {
  const handoffId = typeof message.handoffId === 'string' ? message.handoffId : null;
  const videoId = typeof message.videoId === 'string' && /^[A-Za-z0-9_-]{11}$/.test(message.videoId)
    ? message.videoId
    : null;
  const targetTime = Number(message.serverTime);
  if (!handoffId || !videoId || !Number.isFinite(targetTime)) return;

  localCommandPending = null;
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
  serverMutation = {
    source: 'handoff-commit',
    action: desiredState === 1 ? 'play' : 'pause',
    suppressTelemetry: false,
    expiresAt: performance.now() + 2_500,
  };

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

  serverMutation = {
    source: 'handoff-release',
    action: 'pause',
    suppressTelemetry: true,
    expiresAt: performance.now() + 2_000,
  };
  try {
    player.pauseVideo();
  } catch {}
  noteNode.textContent = 'Room playback moved with the microphone. This player is no longer driving the shared song.';
}

function completeRoomSong(message) {
  if (!pendingHandoff || message.handoffId !== pendingHandoff.handoffId) return;
  clearHandoffReadyTimers();
  pendingHandoff = null;
  handoffReadySent = false;
  noteNode.textContent = 'Room playback handoff complete. This device now follows the shared song.';
}

function loadVideo() {
  const videoId = parseVideoId(input.value);
  if (!videoId) {
    stateNode.textContent = 'invalid URL / video ID';
    noteNode.textContent = 'Paste a YouTube watch, youtu.be, Shorts, Live, Embed URL, or an 11-character video ID.';
    return;
  }

  requestRoomSongCommand({ action: 'load', videoId, positionSeconds: 0 });
}

function trackedRoomCommandId() {
  return localCommandPending?.commandId
    ?? (serverMutation?.source === 'room-command' ? serverMutation.commandId : null);
}

window.addEventListener('relay:room-song-command-sent', (event) => {
  if (!localCommandPending) return;
  localCommandPending.commandId = event.detail?.commandId ?? null;
});
window.addEventListener('relay:room-song-command-accepted', (event) => {
  if (localCommandPending?.commandId === event.detail?.commandId) {
    noteNode.textContent = `Latest room ${localCommandPending.action} accepted. Applying on this playback device…`;
  }
});
window.addEventListener('relay:room-song-command-apply', (event) => {
  const detail = event.detail ?? {};
  if (localCommandPending?.commandId === detail.commandId) localCommandPending = null;
  applyRoomSongCommand(detail).catch(console.error);
});
window.addEventListener('relay:room-song-command-rejected', (event) => {
  const detail = event.detail ?? {};
  const trackedCommandId = trackedRoomCommandId();
  if (trackedCommandId && detail.commandId && trackedCommandId !== detail.commandId) return;
  localCommandPending = null;
  if (serverMutation?.source === 'room-command') serverMutation = null;
  noteNode.textContent = `Room song command rejected: ${detail.reason ?? 'not allowed'}.`;
  restoreAuthoritativeRoom(detail.room).catch(console.error);
});
window.addEventListener('relay:room-song-command-complete', (event) => {
  const commandId = event.detail?.commandId;
  const trackedCommandId = trackedRoomCommandId();
  if (trackedCommandId && commandId && trackedCommandId !== commandId) return;
  if (serverMutation?.commandId === commandId) serverMutation = null;
  if (localCommandPending?.commandId === commandId) localCommandPending = null;
  noteNode.textContent = 'Latest room song intent applied.';
});
window.addEventListener('relay:room-song-command-failed-ack', (event) => {
  const detail = event.detail ?? {};
  const commandId = detail.commandId;
  const trackedCommandId = trackedRoomCommandId();
  if (trackedCommandId && commandId && trackedCommandId !== commandId) return;
  localCommandPending = null;
  if (serverMutation?.source === 'room-command') serverMutation = null;
  noteNode.textContent = 'Playback could not apply the latest room intent. Restoring the authoritative room song.';
  restoreAuthoritativeRoom(detail.room).catch(console.error);
});
window.addEventListener('relay:room-song-command-status', (event) => {
  const detail = event.detail ?? {};
  const pendingCommandId = detail.pendingCommandId;
  const trackedCommandId = trackedRoomCommandId();
  if (!trackedCommandId || pendingCommandId !== null) return;

  // Completion is delivered before the terminal pending=null status on the
  // same WebSocket. Reaching this branch therefore means timeout, disconnect,
  // or another terminal cleanup for the latest command this page still tracks.
  localCommandPending = null;
  if (serverMutation?.source === 'room-command') serverMutation = null;
  noteNode.textContent = 'Latest room song intent ended without playback confirmation. Restoring the authoritative room song.';
  restoreAuthoritativeRoom(detail.room).catch(console.error);
});

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

loadButton.addEventListener('click', loadVideo);

input.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  loadVideo();
});

stateNode.textContent = 'not loaded';
timelineNode.textContent = '--:-- / --:--';
noteNode.textContent = 'Load a video, then use the visible YouTube controls. Shared song changes are authorized by Relay; joining the room never starts playback by itself.';
