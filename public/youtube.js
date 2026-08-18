import './playback-prewarm-trigger.js';
import { playbackContinuationDecision, reloadDesiredFromRoom } from './playback-continuation.js';

const t = (key, vars) => window.relayI18n?.t(key, vars) ?? key;
const input = document.querySelector('#youtube-url');
const loadButton = document.querySelector('#load-youtube');
const stateNode = document.querySelector('#youtube-state');
const timelineNode = document.querySelector('#youtube-timeline');
const noteNode = document.querySelector('#youtube-note');

const STATE_NAMES = new Map([
  [-1, 'song.state.preparing'],
  [0, 'song.state.ended'],
  [1, 'song.state.playing'],
  [2, 'song.state.paused'],
  [3, 'song.state.buffering'],
  [5, 'song.state.ready'],
]);

const ERROR_NAMES = new Map([
  [2, 'invalid video ID'],
  [5, 'HTML5 playback error'],
  [100, 'video unavailable'],
  [101, 'embedding disabled by owner'],
  [150, 'embedding disabled by owner'],
  [153, 'missing Referer / client identity'],
]);

// The server owns the 5 s proof deadline and sweeps every 250 ms. The browser
// timer is only a late local safety net, so keep it comfortably behind the
// authoritative deadline rather than racing the server at the same instant.
const HANDOFF_COMMIT_TIMEOUT_MS = 6_500;
// Confirmation-time media work is speculative. It must eventually retire even
// if Mic ownership succeeds but a formal playback handoff never arrives.
const SPECULATIVE_PREWARM_TIMEOUT_MS = 15_000;
// The direct release packet normally follows the promotion status on the same
// WebSocket. This timer is only damage containment for a broken/disconnected
// control path so an old page cannot remain audible forever.
const OUTGOING_RELEASE_FALLBACK_MS = 2_000;
const AUTOPLAY_RECOVERY_NOTE = 'Playback moved here, but the browser paused audio. Tap Play once in the visible YouTube player.';

let player = null;
let playerReady = false;
let loadedVideoId = null;
let telemetryTimer = null;
let previousSnapshot = null;
let apiPromise = null;
let pendingHandoff = null;
let handoffReadySent = false;
let handoffReadyTimers = [];
let handoffCommitTimer = null;
let speculativePrewarmTimer = null;
let outgoingReleaseTimer = null;
let autoplayRecoveryTimer = null;
let autoplayRecoveryGeneration = 0;
let localCommandPending = null;
let serverMutation = null;
let playbackRole = 'connecting';
let continuationRestoreKey = null;
let latestPlaybackRoom = null;
let speculativePrewarm = null;
let outgoingHandoffId = null;
let autoplayRecoveryRequired = false;

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
  const key = STATE_NAMES.get(state);
  const label = key ? t(key) : `state ${state}`;
  stateNode.textContent = detail ? `${label} · ${detail}` : label;
}

function reportedVideoId() {
  try {
    const value = player?.getVideoData?.()?.video_id;
    return typeof value === 'string' && value ? value : null;
  } catch {
    return null;
  }
}

function actualVideoId() {
  return reportedVideoId() ?? loadedVideoId;
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
  // Room commands and same-tab reload restoration stay authoritative until the
  // server proves convergence. Local timeouts would otherwise erase the exact
  // mutation identity while the iframe is still loading or autoplay is waiting
  // on a user gesture.
  if (serverMutation.source === 'room-command' || serverMutation.source === 'restore') return serverMutation;
  if (performance.now() <= serverMutation.expiresAt) return serverMutation;
  serverMutation = null;
  return null;
}

function requestRoomSongCommand(detail) {
  // The server is the playback-authority boundary. In particular, a page that
  // still renders as observer may legitimately recover a stale/disconnected
  // leader. Do not veto that request from a possibly older client snapshot.
  localCommandPending = {
    action: detail.action,
    commandId: null,
    requestedAt: performance.now(),
  };
  noteNode.textContent = t('song.requestingAction', { action: detail.action });
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
    ? t('song.buffered', { percent: Math.round(snapshot.bufferedFraction * 100) })
    : t('song.bufferUnknown');

  timelineNode.textContent = `${formatTime(snapshot.currentTime)} / ${formatTime(snapshot.duration)} · ${snapshot.playbackRate || 1}× · ${buffered}`;

  // A post-handoff WebKit recovery CTA is product state, not a transient note.
  // Normal telemetry may update the timeline readout but cannot erase the CTA;
  // only observed PLAYING (or a stronger explicit lifecycle transition) clears it.
  if (!autoplayRecoveryRequired) {
    if (Math.abs(snapshot.timelineDeltaSeconds) > 0.4) {
      const sign = snapshot.timelineDeltaSeconds > 0 ? '+' : '';
      noteNode.textContent = t('song.timelineJump', { delta: `${sign}${snapshot.timelineDeltaSeconds.toFixed(2)}` });
    } else if (snapshot.state === 3) {
      noteNode.textContent = t('song.bufferingIndependent');
    } else if (!pendingHandoff && !localCommandPending && !activeServerMutation()) {
      noteNode.textContent = t('song.timelineAuthorized');
    }
  }

  const mutationContext = activeServerMutation();

  // Speculative warming is strictly local. In particular, an empty/recoverable
  // surface must not turn the hidden muted playback performed while the Mic
  // confirmation is open into a new room command or a competing media clock.
  if (speculativePrewarm && !pendingHandoff) return;

  // A normal observer never publishes a competing media clock. A server-applied
  // room command is different: the server has already authorized this exact
  // transport as the recovery target, so it must be allowed to publish proof
  // even before the next snapshot promotes the page from observer to holder.
  if (playbackRole === 'observer' && mutationContext?.source !== 'room-command') return;

  // During preparation the target player is deliberately loading while muted
  // before it owns the room clock. Do not turn that local preparation into
  // product input.
  if (pendingHandoff?.phase === 'preparing') return;

  // Even after commit, the expected video id is not proof that the iframe has
  // switched. YouTube may temporarily return no video data while changing
  // media; loadedVideoId is only our intent. Never let that fallback complete a
  // handoff or overwrite the room clock with the outgoing video's position.
  if (
    pendingHandoff?.phase === 'committing'
    && reportedVideoId() !== pendingHandoff.videoId
  ) return;

  // Detect a newer native control gesture even while an earlier command is
  // awaiting acceptance/proof. Stable intermediate telemetry stays suppressed
  // until the latest local intent has a server apply.
  const mutation = localMutationForSnapshot(snapshot);
  if (mutation) {
    requestRoomSongCommand(mutation);
    return;
  }
  if (localCommandPending) return;

  if (mutationContext?.suppressTelemetry) return;

  // A reload continuation creates a fresh iframe whose first observable state
  // can be CUED at 0 seconds. That transient state is not room truth. Publish
  // only after the fresh player has converged on the authoritative snapshot;
  // that packet is the proof SongSession needs to promote the new generation.
  if (
    mutationContext?.source === 'restore'
    && !snapshotMatchesDesired(snapshot, mutationContext)
  ) return;

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
  if (snapshot.state === 1 && autoplayRecoveryRequired) clearAutoplayRecovery();
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

function clearHandoffCommitTimer() {
  if (handoffCommitTimer !== null) clearTimeout(handoffCommitTimer);
  handoffCommitTimer = null;
}

function clearSpeculativePrewarmTimer() {
  if (speculativePrewarmTimer !== null) clearTimeout(speculativePrewarmTimer);
  speculativePrewarmTimer = null;
}

function clearOutgoingReleaseTimer() {
  if (outgoingReleaseTimer !== null) clearTimeout(outgoingReleaseTimer);
  outgoingReleaseTimer = null;
}

function clearAutoplayRecovery() {
  if (autoplayRecoveryTimer !== null) clearTimeout(autoplayRecoveryTimer);
  autoplayRecoveryTimer = null;
  autoplayRecoveryGeneration += 1;
  autoplayRecoveryRequired = false;
}

function retireOutgoingReleaseBarrier() {
  outgoingHandoffId = null;
  clearOutgoingReleaseTimer();
}

function armSpeculativePrewarmTimeout(prewarm) {
  clearSpeculativePrewarmTimer();
  speculativePrewarmTimer = setTimeout(() => {
    if (speculativePrewarm === prewarm && !pendingHandoff) cancelPlaybackPrewarm();
  }, SPECULATIVE_PREWARM_TIMEOUT_MS);
}

function armOutgoingReleaseFallback(handoffId) {
  clearOutgoingReleaseTimer();
  outgoingReleaseTimer = setTimeout(() => {
    if (!handoffId || outgoingHandoffId !== handoffId) return;
    retireOutgoingReleaseBarrier();
    clearAutoplayRecovery();
    if (!playerReady || !player) return;
    serverMutation = {
      source: 'handoff-release-fallback',
      action: 'pause',
      suppressTelemetry: true,
      expiresAt: performance.now() + 1_200,
    };
    try { player.pauseVideo(); } catch {}
    noteNode.textContent = t('song.movedWithMic');
  }, OUTGOING_RELEASE_FALLBACK_MS);
}

function announceHandoffReady() {
  if (!pendingHandoff || pendingHandoff.phase !== 'preparing' || handoffReadySent) return false;
  if (!playerReady || !player || reportedVideoId() !== pendingHandoff.videoId) return false;

  const state = Number(player.getPlayerState());
  const bufferedFraction = Number(player.getVideoLoadedFraction());
  const desiredPlaying = pendingHandoff.desiredState === 1 || pendingHandoff.desiredState === 3;
  // BUFFERING is progress, not readiness. `getVideoLoadedFraction()` is an
  // overall-video fraction and cannot prove that the target timestamp is
  // renderable. For a playing room, require the iframe to have actually reached
  // PLAYING; for a paused/terminal room, require the prepared player to be
  // PAUSED. The server applies its own proof gate again after commit.
  if (desiredPlaying ? state !== 1 : state !== 2) return false;
  if (!Number.isFinite(bufferedFraction) || bufferedFraction <= 0) return false;

  handoffReadySent = true;
  clearHandoffReadyTimers();
  noteNode.textContent = t('song.handoffPrepared');
  window.dispatchEvent(new CustomEvent('relay:song-handoff-ready', {
    detail: { handoffId: pendingHandoff.handoffId },
  }));
  return true;
}

function scheduleHandoffReadyChecks() {
  clearHandoffReadyTimers();
  // Loaded fraction and state can advance without a useful state callback on
  // every platform. Keep polling beneath the server's prepare deadline so a
  // slow phone can become ready without a reload or another user gesture.
  for (const delayMs of [80, 220, 500, 900, 1_500, 2_400, 4_000, 7_000, 11_000, 16_000]) {
    handoffReadyTimers.push(setTimeout(announceHandoffReady, delayMs));
  }
}

function projectedPrewarmPosition(prewarm, now = performance.now()) {
  if (!prewarm) return 0;
  const elapsedSeconds = prewarm.desiredState === 1
    ? Math.max(0, now - prewarm.startedAtPerformanceMs) / 1000
    : 0;
  return Math.max(0, prewarm.targetTime + elapsedSeconds * prewarm.playbackRate);
}

function restorePrewarmMute(prewarm) {
  if (!prewarm || !playerReady || !player) return;
  if (prewarm.wasMuted === false) {
    try { player.unMute(); } catch {}
  }
}

function primeSpeculativePrewarm() {
  if (!speculativePrewarm || pendingHandoff || !playerReady || !player) return false;

  const prewarm = speculativePrewarm;
  const targetTime = projectedPrewarmPosition(prewarm);
  try {
    if (prewarm.wasMuted === null) {
      try { prewarm.wasMuted = Boolean(player.isMuted()); } catch {}
    }
    try { player.mute(); } catch {}
    loadedVideoId = prewarm.videoId;
    previousSnapshot = null;
    // cueVideoById only loads a thumbnail. A muted load is deliberate here: it
    // makes YouTube request and decode the actual media while the confirmation
    // is open, without becoming audible or gaining any room authority.
    player.loadVideoById({
      videoId: prewarm.videoId,
      startSeconds: targetTime,
    });
    try { player.setPlaybackRate(prewarm.playbackRate); } catch {}
    return true;
  } catch (error) {
    console.warn('Could not prewarm room song playback', error);
    if (speculativePrewarm === prewarm) {
      clearSpeculativePrewarmTimer();
      restorePrewarmMute(prewarm);
      speculativePrewarm = null;
    }
    return false;
  }
}

async function startPlaybackPrewarm() {
  if (pendingHandoff || localCommandPending) return false;
  if (playbackRole === 'holder' || playbackRole === 'preparing') return false;
  if (serverMutation?.source === 'room-command' || serverMutation?.source === 'restore') return false;

  const desired = reloadDesiredFromRoom(latestPlaybackRoom);
  if (!desired?.videoId) return false;

  // A second Mic tap while the same confirmation is open must not replace the
  // object that remembers whether the player was audible before Relay muted it.
  // Otherwise the second attempt observes Relay's own mute and loses the only
  // provenance needed to restore the user's original state.
  if (speculativePrewarm?.videoId === desired.videoId) {
    speculativePrewarm.targetTime = Math.max(0, desired.positionSeconds);
    speculativePrewarm.desiredState = desired.state;
    speculativePrewarm.playbackRate = desired.playbackRate;
    speculativePrewarm.startedAtPerformanceMs = performance.now();
    armSpeculativePrewarmTimeout(speculativePrewarm);
    if (playerReady) primeSpeculativePrewarm();
    return true;
  }
  if (speculativePrewarm) cancelPlaybackPrewarm();

  const prewarm = {
    videoId: desired.videoId,
    targetTime: Math.max(0, desired.positionSeconds),
    desiredState: desired.state,
    playbackRate: desired.playbackRate,
    startedAtPerformanceMs: performance.now(),
    wasMuted: null,
  };
  speculativePrewarm = prewarm;
  armSpeculativePrewarmTimeout(prewarm);

  try {
    await ensurePlayer(prewarm.videoId);
    if (speculativePrewarm !== prewarm || pendingHandoff) return false;
    if (playerReady) primeSpeculativePrewarm();
    return true;
  } catch (error) {
    console.warn('Could not initialize speculative room playback', error);
    if (speculativePrewarm === prewarm) {
      clearSpeculativePrewarmTimer();
      restorePrewarmMute(prewarm);
      speculativePrewarm = null;
    }
    return false;
  }
}

function cancelPlaybackPrewarm() {
  const prewarm = speculativePrewarm;
  clearSpeculativePrewarmTimer();
  speculativePrewarm = null;
  if (!prewarm || pendingHandoff || !playerReady || !player) return;
  if (reportedVideoId() === prewarm.videoId) {
    try { player.pauseVideo(); } catch {}
  }
  restorePrewarmMute(prewarm);
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

    if (pendingHandoff.prewarmWasMuted === null) {
      try { pendingHandoff.prewarmWasMuted = Boolean(player.isMuted()); } catch {}
    }
    try { player.mute(); } catch {}

    const canReuse = pendingHandoff.reusePreparedPlayer === true
      && reportedVideoId() === pendingHandoff.videoId;
    if (canReuse) {
      const currentTime = Number(player.getCurrentTime());
      if (!Number.isFinite(currentTime) || Math.abs(currentTime - pendingHandoff.targetTime) > 0.75) {
        player.seekTo(pendingHandoff.targetTime, true);
      }
    } else {
      // A cold formal handoff needs the same real-media preparation as the
      // speculative path. `loadVideoById` starts the request/decode pipeline;
      // muting above keeps it inaudible until the server commits authority.
      player.loadVideoById({
        videoId: pendingHandoff.videoId,
        startSeconds: Math.max(0, pendingHandoff.targetTime),
      });
    }
    try { player.setPlaybackRate(pendingHandoff.playbackRate); } catch {}
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

function applyAuthoritativeRestore() {
  if (serverMutation?.source !== 'restore' || !playerReady || !player) return false;
  const mutation = serverMutation;
  const desired = mutation.desired;
  if (!desired) return false;

  const projectedPosition = projectedDesiredPosition(mutation);
  const targetPosition = Number.isFinite(projectedPosition)
    ? Math.max(0, projectedPosition)
    : desired.positionSeconds;

  loadedVideoId = desired.videoId;
  previousSnapshot = null;
  mutation.desired = { ...desired, positionSeconds: targetPosition };
  mutation.appliedAtPerformanceMs = performance.now();

  if (desired.state === 5) {
    player.cueVideoById({
      videoId: desired.videoId,
      startSeconds: targetPosition,
    });
    player.setPlaybackRate(desired.playbackRate);
  } else {
    if (reportedVideoId() !== desired.videoId) {
      player.cueVideoById({
        videoId: desired.videoId,
        startSeconds: targetPosition,
      });
    }
    player.seekTo(targetPosition, true);
    player.setPlaybackRate(desired.playbackRate);
    if (desired.state === 1) player.playVideo();
    else player.pauseVideo();
  }

  noteNode.textContent = 'Restoring this playback after reload…';
  setTimeout(sampleNow, 100);
  setTimeout(sampleNow, 260);
  return true;
}

function handleReady(event) {
  playerReady = true;
  const iframe = event.target.getIframe();
  iframe.referrerPolicy = 'strict-origin-when-cross-origin';
  setPlayerState(event.target.getPlayerState(), 'ready');

  if (pendingHandoff?.phase === 'preparing') {
    startTelemetry();
    cuePendingHandoff();
    return;
  }

  if (speculativePrewarm) {
    startTelemetry();
    primeSpeculativePrewarm();
    return;
  }

  const pendingRoomApply = serverMutation?.source === 'room-command'
    ? {
        commandId: serverMutation.commandId,
        revision: serverMutation.revision,
        action: serverMutation.action,
        desired: serverMutation.desired,
      }
    : null;
  if (pendingRoomApply) {
    // The first load can create the iframe before YT reports ready. Re-apply the
    // latest self-contained desired state here rather than relying on whatever
    // initial state the iframe happened to choose.
    applyRoomSongCommand(pendingRoomApply)
      .catch(console.error)
      .finally(startTelemetry);
    return;
  }

  if (serverMutation?.source === 'restore') {
    try {
      applyAuthoritativeRestore();
    } catch (error) {
      console.warn('Could not apply reload playback restore', error);
      serverMutation = null;
      continuationRestoreKey = null;
    }
  }

  startTelemetry();
}

function handleStateChange(event) {
  if (event.data === 1 && autoplayRecoveryRequired) clearAutoplayRecovery();
  setPlayerState(event.data);
  sampleNow();
  if (speculativePrewarm && !pendingHandoff) {
    try { player.setPlaybackRate(speculativePrewarm.playbackRate); } catch {}
    // A paused/cued authoritative room still benefits from forcing one real
    // media request. Stop as soon as the muted player proves it can play so the
    // speculative copy does not drift away from the fixed room position.
    if (speculativePrewarm.desiredState !== 1 && event.data === 1) {
      try { player.pauseVideo(); } catch {}
    }
  }
  if (pendingHandoff?.phase === 'preparing') {
    try { player.setPlaybackRate(pendingHandoff.playbackRate); } catch {}
    if (pendingHandoff.desiredState !== 1 && event.data === 1) {
      try { player.pauseVideo(); } catch {}
    }
    announceHandoffReady();
  }
}

function handlePlaybackRateChange(event) {
  setPlayerState(player?.getPlayerState?.() ?? -1, `${event.data}×`);
  sampleNow();
}

function handleError(event) {
  clearAutoplayRecovery();
  const label = ERROR_NAMES.get(event.data) ?? `YouTube error ${event.data}`;
  setPlayerState(-1, label);
  noteNode.textContent = `Player error ${event.data}: ${label}.`;
  if (speculativePrewarm && !pendingHandoff) {
    const prewarm = speculativePrewarm;
    clearSpeculativePrewarmTimer();
    speculativePrewarm = null;
    restorePrewarmMute(prewarm);
  }
  if (pendingHandoff?.phase === 'committing') {
    rollbackCommittedHandoff(`youtube-error-${event.data}`);
  } else if (pendingHandoff) {
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

function rollbackCommittedHandoff(reason) {
  if (!pendingHandoff || pendingHandoff.phase !== 'committing') return false;

  const handoffId = pendingHandoff.handoffId;
  clearHandoffCommitTimer();
  pendingHandoff.phase = 'preparing';
  handoffReadySent = false;
  serverMutation = {
    source: 'handoff-prepare',
    action: 'load',
    suppressTelemetry: true,
    expiresAt: performance.now() + 3_000,
  };

  if (playerReady && player) {
    try { player.pauseVideo(); } catch {}
    try { player.mute(); } catch {}
  }

  window.dispatchEvent(new CustomEvent('relay:song-handoff-failed', {
    detail: { handoffId, reason },
  }));
  return true;
}

function handleAutoplayBlocked() {
  if (speculativePrewarm && !pendingHandoff) return;

  noteNode.textContent = pendingHandoff?.phase === 'committing'
    ? 'Browser blocked the playback handoff. Tap Play once in the visible YouTube player; Relay will retry without dropping the old playback first.'
    : 'Browser blocked scripted playback. Tap Play directly inside the visible YouTube player.';

  if (pendingHandoff?.phase === 'committing') {
    rollbackCommittedHandoff('autoplay-blocked');
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

  clearAutoplayRecovery();
  retireOutgoingReleaseBarrier();
  cancelPlaybackPrewarm();
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

    // Keep the previous sample across a command apply. The full desired-state
    // matcher distinguishes server mutations, while preserving enough history
    // to notice a user seek/play/pause that lands before the next sample.
    loadedVideoId = desired.videoId;
    serverMutation.appliedAtPerformanceMs = performance.now();

    if (desired.state === 5) {
      player.cueVideoById({
        videoId: desired.videoId,
        startSeconds: Math.max(0, desired.positionSeconds),
      });
    } else {
      if (reportedVideoId() !== desired.videoId) {
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
  clearAutoplayRecovery();
  cancelPlaybackPrewarm();

  const desired = reloadDesiredFromRoom(room);
  const videoId = desired?.videoId ?? null;
  if (!videoId) {
    continuationRestoreKey = null;
    if (serverMutation?.source === 'restore') serverMutation = null;
    if (playerReady && player) {
      serverMutation = {
        source: 'restore-empty',
        action: 'pause',
        suppressTelemetry: true,
        expiresAt: performance.now() + 1_500,
      };
      try { player.pauseVideo(); } catch {}
    }
    return;
  }

  try {
    serverMutation = {
      source: 'restore',
      action: 'restore',
      desired,
      appliedAtPerformanceMs: performance.now(),
      suppressTelemetry: false,
      expiresAt: Number.POSITIVE_INFINITY,
    };
    await ensurePlayer(videoId);
    if (!playerReady || !player) {
      noteNode.textContent = 'Restoring this playback after reload…';
      return;
    }
    applyAuthoritativeRestore();
  } catch (error) {
    console.warn('Could not restore authoritative room song', error);
    if (serverMutation?.source === 'restore') serverMutation = null;
    continuationRestoreKey = null;
  }
}

async function prepareRoomSong(message) {
  const handoffId = typeof message.handoffId === 'string' ? message.handoffId : null;
  const videoId = typeof message.videoId === 'string' && /^[A-Za-z0-9_-]{11}$/.test(message.videoId)
    ? message.videoId
    : null;
  const targetTime = Number(message.serverTime);
  if (!handoffId || !videoId || !Number.isFinite(targetTime)) return;

  clearAutoplayRecovery();
  retireOutgoingReleaseBarrier();
  const preparedPrewarm = speculativePrewarm;
  const reusePreparedPlayer = Boolean(
    preparedPrewarm
    && preparedPrewarm.videoId === videoId
    && playerReady
    && player
    && reportedVideoId() === videoId,
  );
  clearSpeculativePrewarmTimer();
  speculativePrewarm = null;
  if (preparedPrewarm && !reusePreparedPlayer) {
    if (playerReady && player) {
      try { player.pauseVideo(); } catch {}
    }
    restorePrewarmMute(preparedPrewarm);
  }

  // A newer handoff can replace an older preparation on the same page, for
  // example when Mic ownership changes while a reload is still converging.
  // Retire every delayed readiness/commit callback before installing the new
  // identity; otherwise old work can mutate the replacement handoff.
  clearHandoffReadyTimers();
  clearHandoffCommitTimer();
  localCommandPending = null;
  pendingHandoff = {
    handoffId,
    videoId,
    targetTime: Math.max(0, targetTime),
    desiredState: Number(message.state),
    playbackRate: Number.isFinite(Number(message.playbackRate)) && Number(message.playbackRate) > 0
      ? Number(message.playbackRate)
      : 1,
    reusePreparedPlayer,
    prewarmWasMuted: reusePreparedPlayer ? preparedPrewarm?.wasMuted ?? null : null,
    phase: 'preparing',
  };
  handoffReadySent = false;
  previousSnapshot = null;
  noteNode.textContent = t('song.preparingHandoff');

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

  clearHandoffCommitTimer();
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
    if (reportedVideoId() !== pendingHandoff.videoId) {
      player.loadVideoById({
        videoId: pendingHandoff.videoId,
        startSeconds: pendingHandoff.targetTime,
      });
    }
    const currentTime = Number(player.getCurrentTime());
    if (!Number.isFinite(currentTime) || Math.abs(currentTime - pendingHandoff.targetTime) > 0.75) {
      player.seekTo(pendingHandoff.targetTime, true);
    }
    // Commit starts the target media clock, but it is still not the audible
    // room source. Keep it muted until server proof promotes this exact
    // transport and sends the explicit completion packet.
    try { player.mute(); } catch {}
    if (desiredState === 1) player.playVideo();
    else player.pauseVideo();

    const committingHandoffId = pendingHandoff.handoffId;
    handoffCommitTimer = setTimeout(() => {
      if (
        pendingHandoff?.handoffId === committingHandoffId
        && pendingHandoff.phase === 'committing'
      ) {
        // The server should already have completed or cancelled by now. This is
        // only local damage containment: park/mute and report failure. Do not
        // reuse a 6.5 s-old targetTime to start another seek loop locally.
        rollbackCommittedHandoff('commit-timeout');
      }
    }, HANDOFF_COMMIT_TIMEOUT_MS);

    setTimeout(sampleNow, 80);
    setTimeout(sampleNow, 220);
    noteNode.textContent = t('song.switchingHere');
  } catch (error) {
    console.warn('Could not commit room song handoff', error);
    rollbackCommittedHandoff('commit-failed');
  }
}

function releaseRoomSong(message) {
  if (outgoingHandoffId && typeof message.handoffId === 'string' && message.handoffId !== outgoingHandoffId) {
    return;
  }
  if (!playerReady || !player) return;
  if (typeof message.videoId === 'string' && loadedVideoId !== message.videoId) return;

  retireOutgoingReleaseBarrier();
  clearAutoplayRecovery();
  serverMutation = {
    source: 'handoff-release',
    action: 'pause',
    suppressTelemetry: true,
    expiresAt: performance.now() + 2_000,
  };
  try {
    player.pauseVideo();
  } catch {}
  noteNode.textContent = t('song.movedWithMic');
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
  const prewarmWasMuted = pendingHandoff.prewarmWasMuted;
  clearHandoffReadyTimers();
  clearHandoffCommitTimer();
  pendingHandoff = null;
  handoffReadySent = false;
  clearAutoplayRecovery();
  if (playerReady && player) {
    try { player.pauseVideo(); } catch {}
    if (prewarmWasMuted === false) {
      try { player.unMute(); } catch {}
    }
  }
  noteNode.textContent = t('song.handoffCancelled');
}

function completeRoomSong(message) {
  if (!pendingHandoff || message.handoffId !== pendingHandoff.handoffId) return;
  const prewarmWasMuted = pendingHandoff.prewarmWasMuted;
  const desiredState = pendingHandoff.desiredState;
  clearHandoffReadyTimers();
  clearHandoffCommitTimer();
  pendingHandoff = null;
  handoffReadySent = false;
  clearAutoplayRecovery();
  // Only the explicit server completion packet restores audibility. A timeline
  // status broadcast is intentionally insufficient because the server sends the
  // promoted timeline before it sends the outgoing leader's release packet.
  if (playerReady && player && prewarmWasMuted === false) {
    try { player.unMute(); } catch {}
    // WebKit may pause media when a muted autoplay is unmuted without a fresh
    // user gesture. We cannot manufacture that gesture after an async server
    // round-trip, so detect the failure and persist the real recovery state
    // instead of letting ordinary telemetry overwrite it two seconds later.
    if (desiredState === 1) {
      const recoveryGeneration = autoplayRecoveryGeneration;
      autoplayRecoveryTimer = setTimeout(() => {
        autoplayRecoveryTimer = null;
        if (recoveryGeneration !== autoplayRecoveryGeneration) return;
        if (Number(player?.getPlayerState?.()) !== 1) {
          autoplayRecoveryRequired = true;
          noteNode.textContent = AUTOPLAY_RECOVERY_NOTE;
        }
      }, 300);
    }
  }
  noteNode.textContent = t('song.handoffComplete');
}

function loadVideo() {
  const videoId = parseVideoId(input.value);
  if (!videoId) {
    stateNode.textContent = t('song.invalidVideo');
    noteNode.textContent = t('song.invalidVideoHelp');
    return;
  }

  requestRoomSongCommand({ action: 'load', videoId, positionSeconds: 0 });
}

function trackedRoomCommandId() {
  return localCommandPending?.commandId
    ?? (serverMutation?.source === 'room-command' ? serverMutation.commandId : null);
}

window.addEventListener('relay:playback-view', (event) => {
  const detail = event.detail ?? {};
  latestPlaybackRoom = detail.room && typeof detail.room === 'object'
    ? detail.room
    : null;
  const nextRole = detail.role;
  if (!['empty', 'holder', 'preparing', 'observer'].includes(nextRole)) return;

  if (
    speculativePrewarm
    && (!latestPlaybackRoom?.videoId || latestPlaybackRoom.videoId !== speculativePrewarm.videoId)
  ) {
    cancelPlaybackPrewarm();
  }

  const timeline = detail.timeline && typeof detail.timeline === 'object'
    ? detail.timeline
    : null;
  const leaderGeneration = Number(timeline?.playbackGeneration);
  const currentGeneration = Number(detail.playbackGeneration);
  const sameTransport = Boolean(
    timeline
    && typeof detail.transportId === 'string'
    && timeline.playbackTransportId === detail.transportId,
  );
  const exactCurrentLeader = Boolean(
    sameTransport
    && Number.isInteger(leaderGeneration)
    && Number.isInteger(currentGeneration)
    && leaderGeneration === currentGeneration,
  );
  const activeOutgoingHandoffId = exactCurrentLeader
    && timeline?.handoffState !== 'idle'
    && typeof timeline?.handoffId === 'string'
    ? timeline.handoffId
    : null;
  if (activeOutgoingHandoffId) {
    outgoingHandoffId = activeOutgoingHandoffId;
    clearOutgoingReleaseTimer();
  } else if (nextRole === 'holder' && timeline?.handoffState === 'idle' && outgoingHandoffId) {
    // The handoff was cancelled while this page remained/returned holder. A
    // stale fallback must not pause the still-authoritative old player later.
    retireOutgoingReleaseBarrier();
  }

  const continuingSameTransport = Boolean(
    nextRole === 'holder'
    && typeof detail.room?.videoId === 'string'
    && sameTransport
    && Number.isInteger(leaderGeneration)
    && Number.isInteger(currentGeneration)
    && currentGeneration > leaderGeneration,
  );
  const continuationComplete = Boolean(
    nextRole === 'holder'
    && sameTransport
    && Number.isInteger(leaderGeneration)
    && Number.isInteger(currentGeneration)
    && currentGeneration === leaderGeneration,
  );

  if (continuingSameTransport) {
    const restoreKey = playbackContinuationDecision({
      role: nextRole,
      room: detail.room,
      timeline,
      transportId: detail.transportId,
      playbackGeneration: currentGeneration,
    }).key;
    if (restoreKey && continuationRestoreKey !== restoreKey) {
      continuationRestoreKey = restoreKey;
      restoreAuthoritativeRoom(detail.room).catch((error) => {
        continuationRestoreKey = null;
        console.error(error);
      });
    }
  } else if (continuationComplete) {
    continuationRestoreKey = null;
    if (serverMutation?.source === 'restore') serverMutation = null;
  }

  if (nextRole === playbackRole) return;

  playbackRole = nextRole;
  if (nextRole === 'observer') {
    continuationRestoreKey = null;
    localCommandPending = null;
    if (serverMutation?.source === 'room-command' || serverMutation?.source === 'restore') serverMutation = null;

    // A successful handoff promotion is broadcast before the server's direct
    // release packet. The old holder must not treat that generic observer role
    // change as the audible cutover barrier or both phones can be silent while
    // B is still muted waiting for `song-handoff-complete`. Remembering the
    // active outgoing handoff lets the same-socket direct release do the pause.
    if (outgoingHandoffId) {
      armOutgoingReleaseFallback(outgoingHandoffId);
      noteNode.textContent = t('song.switchingHere');
      return;
    }

    clearAutoplayRecovery();
    if (playerReady && player) {
      serverMutation = {
        source: 'observer-quiet',
        action: 'pause',
        suppressTelemetry: true,
        expiresAt: performance.now() + 1_200,
      };
      try { player.pauseVideo(); } catch {}
    }
    return;
  }

  if (serverMutation?.source === 'observer-quiet') serverMutation = null;
});

window.addEventListener('relay:playback-prewarm-intent', () => {
  startPlaybackPrewarm().catch(console.error);
});
window.addEventListener('relay:playback-prewarm-cancel', () => {
  cancelPlaybackPrewarm();
});

window.addEventListener('relay:recover-room-song', () => {
  requestRoomSongCommand({ action: 'play' });
});

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
window.addEventListener('relay:song-handoff-cancelled', () => {
  cancelRoomSongHandoff();
});

loadButton.addEventListener('click', loadVideo);

input.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  loadVideo();
});

function rerenderLocale() {
  if (playerReady && player && loadedVideoId) setPlayerState(Number(player.getPlayerState()));
  else stateNode.textContent = t('song.notLoaded');
  if (previousSnapshot) {
    const buffered = Number.isFinite(previousSnapshot.bufferedFraction)
      ? t('song.buffered', { percent: Math.round(previousSnapshot.bufferedFraction * 100) })
      : t('song.bufferUnknown');
    timelineNode.textContent = `${formatTime(previousSnapshot.currentTime)} / ${formatTime(previousSnapshot.duration)} · ${previousSnapshot.playbackRate || 1}× · ${buffered}`;
    if (autoplayRecoveryRequired) {
      noteNode.textContent = AUTOPLAY_RECOVERY_NOTE;
    } else {
      noteNode.textContent = previousSnapshot.state === 3
        ? t('song.bufferingIndependent')
        : t('song.timelineAuthorized');
    }
  } else {
    timelineNode.textContent = '--:-- / --:--';
    noteNode.textContent = autoplayRecoveryRequired ? AUTOPLAY_RECOVERY_NOTE : t('song.initialHelp');
  }
}

window.addEventListener('relay-locale-changed', rerenderLocale);
rerenderLocale();