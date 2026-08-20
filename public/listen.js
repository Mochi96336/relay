import {
  createAudioInterruptionTracker,
  shouldRequestAudioResume,
} from './audio-context-recovery.js';
import { sendParticipantAuthentication } from './participant-auth.js';
import {
  claimMicrophoneAudio,
  claimPlaybackAudio,
} from './audio-session-policy.js';
import {
  MONITOR_PCM_PACKET_VERSION,
  createMonitorPcmReceiver,
} from './monitor-pcm-continuity.js';
await window.relayIdentityReady;
import { shouldForceMuteListen } from './playback-recovery.js';

const toggle = document.querySelector('#listen-toggle');
const gainControl = document.querySelector('#listen-gain');
const publisherButton = document.querySelector('#start-publisher');
const takeoverButton = document.querySelector('#confirm-takeover');

if (toggle && gainControl && publisherButton && takeoverButton) {
  const MIX_SAMPLE_RATE = 48_000;
  const RECONNECT_MS = 1_000;
  const PREBUFFER_MS = 250;
  const MAX_QUEUE_MS = 800;
  const monitorPcmReceiver = createMonitorPcmReceiver();
  const audioInterruption = createAudioInterruptionTracker({ staleAfterMs: PREBUFFER_MS });

  let socket = null;
  let pendingSocket = null;
  let transportEpoch = 0;
  let reconnectTimer = null;
  let audioContext = null;
  let playbackNode = null;
  let gainNode = null;
  let audioSetupPromise = null;
  let audioUnlockArmed = false;
  // This is a consecutive recovery counter, not a page-lifetime gesture count.
  // A context that has run successfully gets a fresh retry budget after every
  // interruption instead of being destroyed on the first post-background tap.
  let stalledResumeGestures = 0;
  let audioEverRunning = false;
  let liveEdgeRecoveryRequired = false;
  let transportEnabled = false;
  let userMuted = false;
  let micForcedMuted = false;
  let micMuteEpoch = 0;
  let roomMicForcedMuted = false;
  let playbackForcedMuted = false;
  let takeReviewForcedMuted = false;
  let sourceSampleRate = MIX_SAMPLE_RATE;
  let micPrimaryMode = window.relayMicActionState?.primaryMode === 'takeover'
    ? 'takeover'
    : 'microphone';

  function wsUrl() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const source = new URLSearchParams(location.search);
    const params = new URLSearchParams();
    const key = source.get('key');
    if (key) params.set('key', key);

    const query = params.toString();
    return `${protocol}//${location.host}/ws${query ? `?${query}` : ''}`;
  }

  function linearResample(input, sourceRate, targetRate) {
    if (sourceRate === targetRate) return input;
    const ratio = targetRate / sourceRate;
    const outputLength = Math.max(1, Math.round(input.length * ratio));
    const output = new Float32Array(outputLength);
    for (let i = 0; i < outputLength; i += 1) {
      const sourcePosition = i / ratio;
      const index = Math.floor(sourcePosition);
      const fraction = sourcePosition - index;
      const a = input[Math.min(index, input.length - 1)];
      const b = input[Math.min(index + 1, input.length - 1)];
      output[i] = a + (b - a) * fraction;
    }
    return output;
  }

  function int16ToFloat32(buffer) {
    const input = new Int16Array(buffer);
    const output = new Float32Array(input.length);
    for (let i = 0; i < input.length; i += 1) {
      output[i] = input[i] / (input[i] < 0 ? 0x8000 : 0x7fff);
    }
    return output;
  }

  function volumePercent() {
    return Math.max(0, Math.min(100, Math.round(Number(gainControl.value) || 0)));
  }

  function listenGain() {
    const percent = volumePercent();
    if (percent === 0) return 0;
    // Keep local playback at or below unity. The server mix is already
    // full-scale limited; multiplying it again here would create phone-only clipping.
    return (percent / 100) ** 1.5;
  }

  function effectiveMuted() {
    return userMuted
      || micForcedMuted
      || roomMicForcedMuted
      || playbackForcedMuted
      || takeReviewForcedMuted;
  }

  function audioGraphReady() {
    return Boolean(audioContext && playbackNode && gainNode);
  }

  function audioRendering() {
    return audioGraphReady() && audioContext.state === 'running';
  }

  function monitorTransportWanted() {
    return !effectiveMuted() && audioGraphReady() && audioEverRunning;
  }

  function forcedMuteReason() {
    if (micForcedMuted || roomMicForcedMuted) return 'mic';
    if (playbackForcedMuted) return 'playback';
    if (takeReviewForcedMuted) return 'review';
    return null;
  }

  function listenState(phase = '') {
    const forcedReason = forcedMuteReason();
    const state = forcedReason === 'mic'
      ? 'mic-muted'
      : forcedReason === 'playback'
        ? 'playback-muted'
        : forcedReason === 'review'
          ? 'review-muted'
          : userMuted
            ? 'muted'
            : audioRendering()
              ? 'audible'
              : 'ready';
    return {
      state,
      phase,
      muted: effectiveMuted(),
      forcedReason,
      userMuted,
      volumePercent: volumePercent(),
      audioReady: audioRendering(),
      transportEnabled,
    };
  }

  // Listen owns WebAudio and mute truth. It deliberately does not own product
  // copy or visible control state: room-sound-ui.js is the single presenter.
  function render(phase = '') {
    const detail = listenState(phase);
    window.relayListenState = detail;
    window.dispatchEvent(new CustomEvent('relay-listen-state', { detail }));
  }

  window.addEventListener('relay-request-listen-state', () => render());

  function updateGain() {
    if (gainNode && audioContext) {
      const target = effectiveMuted() ? 0 : listenGain();
      gainNode.gain.setTargetAtTime(target, audioContext.currentTime, 0.01);
    }
  }

  function clearReconnect() {
    if (!reconnectTimer) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function finishAudioInterruptionEvidence() {
    if (!audioEverRunning) return false;
    const recovery = audioInterruption.finish();
    if (recovery.requiresLiveEdge) liveEdgeRecoveryRequired = true;
    return recovery.requiresLiveEdge;
  }

  function resetPlaybackTemporalState() {
    monitorPcmReceiver.reset();
    playbackNode?.port.postMessage({ type: 'reset' });
  }

  function abandonTransportConnection() {
    transportEpoch += 1;
    clearReconnect();
    const opening = pendingSocket;
    pendingSocket = null;
    if (opening) {
      try { opening.close(); } catch {}
    }
    const closing = socket;
    socket = null;
    if (closing) {
      try { closing.close(); } catch {}
    }
    resetPlaybackTemporalState();
  }

  function closeTransport() {
    transportEnabled = false;
    liveEdgeRecoveryRequired = false;
    audioInterruption.reset();
    abandonTransportConnection();
  }

  function scheduleReconnect() {
    if (!transportEnabled || !monitorTransportWanted() || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect().catch(() => {
        if (!transportEnabled || !monitorTransportWanted()) return;
        render('reconnecting');
        scheduleReconnect();
      });
    }, RECONNECT_MS);
  }

  function handleMessage(message) {
    if (message.type === 'session-status') {
      // The monitor socket already receives authoritative room state. Consume it
      // directly so feedback protection does not depend on the Presence socket
      // being healthy in this tab.
      applyRoomSessionStatus(message);
      return;
    }
    if (message.type === 'source-status') {
      sourceSampleRate = Number(message.mixSampleRate ?? message.sampleRate) || MIX_SAMPLE_RATE;
    }
  }

  async function connect() {
    if (
      !transportEnabled
      || !monitorTransportWanted()
      || pendingSocket
      || socket
    ) return;
    const connectEpoch = transportEpoch;
    const next = new WebSocket(wsUrl());
    pendingSocket = next;
    next.binaryType = 'arraybuffer';
    try {
      await new Promise((resolve, reject) => {
        next.addEventListener('open', resolve, { once: true });
        next.addEventListener('error', () => reject(new Error('Listen WebSocket connection failed.')), { once: true });
        next.addEventListener('close', () => reject(new Error('Listen WebSocket closed before opening.')), { once: true });
      });
    } catch (error) {
      try { next.close(); } catch {}
      throw error;
    } finally {
      if (pendingSocket === next) pendingSocket = null;
    }

    if (connectEpoch !== transportEpoch || !transportEnabled || !monitorTransportWanted()) {
      next.close();
      return;
    }

    const previous = socket;
    socket = next;
    if (previous && previous !== next) {
      try { previous.close(); } catch {}
    }
    resetPlaybackTemporalState();
    sendParticipantAuthentication(next);
    next.send(JSON.stringify({
      type: 'register',
      role: 'monitor',
      monitorPacketVersion: MONITOR_PCM_PACKET_VERSION,
    }));

    next.addEventListener('message', (event) => {
      if (socket !== next || connectEpoch !== transportEpoch) return;
      if (typeof event.data === 'string') {
        try { handleMessage(JSON.parse(event.data)); } catch {}
        return;
      }
      if (!(event.data instanceof ArrayBuffer) || !audioGraphReady()) return;

      const received = monitorPcmReceiver.receive(event.data);
      if (received.action !== 'accept') return;

      // Keep framing continuity if Safari leaves this page running in the
      // background, but never build a playback backlog while WebAudio is not
      // rendering. A dropped accepted frame is concrete evidence that playback
      // fell behind; a brief resume with no dropped frame can continue in place.
      if (!audioRendering()) {
        if (audioEverRunning) {
          audioInterruption.begin();
          audioInterruption.noteDroppedPlayback();
        }
        return;
      }

      // WebKit can expose `state === running` before delivering statechange.
      // Finish interruption evidence before any recovered PCM reaches the
      // worklet, otherwise one stale frame can slip through that event-order gap.
      if (finishAudioInterruptionEvidence()) {
        restartMonitorAtLiveEdge();
        return;
      }
      if (liveEdgeRecoveryRequired) return;

      if (received.reset) playbackNode.port.postMessage({ type: 'reset' });
      const pcm = int16ToFloat32(received.frame.pcm);
      const samples = linearResample(pcm, sourceSampleRate, audioContext.sampleRate);
      playbackNode.port.postMessage(samples.buffer, [samples.buffer]);
    });

    next.addEventListener('close', () => {
      if (socket !== next || connectEpoch !== transportEpoch) return;
      socket = null;
      if (!transportEnabled || !monitorTransportWanted()) return;
      render('reconnecting');
      scheduleReconnect();
    });
    next.addEventListener('error', () => {
      try { next.close(); } catch {}
    });
  }

  function ensureTransport(phase = 'connecting') {
    if (!monitorTransportWanted()) return;
    transportEnabled = true;
    if (socket || pendingSocket || reconnectTimer) {
      render(phase);
      return;
    }
    render(phase);
    connect().catch(() => {
      if (!transportEnabled || !monitorTransportWanted()) return;
      render('reconnecting');
      scheduleReconnect();
    });
  }

  function restartMonitorAtLiveEdge() {
    liveEdgeRecoveryRequired = false;
    audioInterruption.reset();
    abandonTransportConnection();
    if (!monitorTransportWanted()) return;
    transportEnabled = true;
    ensureTransport('reconnecting');
  }

  /**
   * Requests a resume without giving anything the chance to wait on it.
   *
   * See ensureAudioGraph: on iOS Safari this promise can stay pending for the
   * life of the page. Callers may only ever fire it and move on.
   */
  function startResume(context) {
    if (!context || !shouldRequestAudioResume(context.state)) return;
    try {
      const pending = context.resume();
      if (pending && typeof pending.catch === 'function') {
        pending.catch((error) => console.warn('Listen AudioContext resume failed', error));
      }
    } catch (error) {
      console.warn('Listen AudioContext resume failed', error);
    }
  }

  function resumeAudioGraph() {
    startResume(audioContext);
  }

  function armAudioUnlock() {
    if (audioUnlockArmed || effectiveMuted() || audioRendering()) return;
    audioUnlockArmed = true;
    window.addEventListener('pointerdown', activateFromGesture, { capture: true });
    window.addEventListener('keydown', activateFromGesture, { capture: true });
  }

  function disarmAudioUnlock() {
    if (!audioUnlockArmed) return;
    audioUnlockArmed = false;
    window.removeEventListener('pointerdown', activateFromGesture, true);
    window.removeEventListener('keydown', activateFromGesture, true);
  }

  function recoverAudioGraph() {
    if (effectiveMuted() || !audioContext) return;
    resumeAudioGraph();
    reconcile('resumed');
  }

  function publishListenHealth(health) {
    const detail = {
      ...health,
      observedAt: performance.now(),
    };
    window.relayListenHealth = detail;
    window.dispatchEvent(new CustomEvent('relay-listen-health', { detail }));
  }

  async function ensureAudioGraph() {
    if (audioGraphReady()) {
      resumeAudioGraph();
      return;
    }
    if (audioSetupPromise) return audioSetupPromise;

    audioSetupPromise = (async () => {
      // Tell iOS this document intends durable media playback before creating
      // the WebAudio graph. Unsupported browsers simply ignore the policy.
      claimPlaybackAudio(true);
      const context = new AudioContext({ latencyHint: 'interactive' });
      audioContext = context;
      context.addEventListener('statechange', () => {
        if (audioContext !== context) return;
        if (context.state === 'running') {
          if (audioEverRunning) finishAudioInterruptionEvidence();
          audioEverRunning = true;
          stalledResumeGestures = 0;
          disarmAudioUnlock();
        } else if (!effectiveMuted()) {
          if (audioEverRunning) audioInterruption.begin();
          startResume(context);
          armAudioUnlock();
        }
        reconcile(context.state === 'running' ? 'resumed' : 'interrupted');
      });
      // Consume the user's first interaction immediately. Fetching the worklet
      // before resume can lose transient autoplay permission on mobile.
      // Asked for, never waited on. iOS Safari leaves this promise pending
      // indefinitely when it will not start the context yet - no error, no
      // resolution - and awaiting it here stranded the whole graph: the
      // worklet was never fetched, `reconcile()` never ran, and because
      // `audioSetupPromise` is only cleared in a `finally` that also never
      // ran, every later press awaited the same dead promise. The button
      // stopped responding for the rest of the session.
      startResume(context);
      await context.audioWorklet.addModule('/playback-worklet.js');

      const node = new AudioWorkletNode(context, 'playback-processor', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      node.port.postMessage({
        type: 'configure',
        prebufferMs: PREBUFFER_MS,
        maxQueueMs: MAX_QUEUE_MS,
      });
      node.port.onmessage = (event) => {
        if (!transportEnabled || effectiveMuted() || !audioRendering()) return;
        if (event.data?.type === 'health') {
          publishListenHealth(event.data);
          return;
        }
        if (event.data?.type === 'buffering') render('buffering');
        if (event.data?.type === 'playing') render('playing');
      };

      const localGain = context.createGain();
      gainNode = localGain;
      playbackNode = node;
      node.connect(localGain).connect(context.destination);
      updateGain();
    })();

    try {
      await audioSetupPromise;
    } catch (error) {
      const failed = audioContext;
      audioContext = null;
      playbackNode = null;
      gainNode = null;
      audioEverRunning = false;
      liveEdgeRecoveryRequired = false;
      audioInterruption.reset();
      claimPlaybackAudio(false);
      try { await failed?.close(); } catch {}
      throw error;
    } finally {
      audioSetupPromise = null;
    }
  }

  function reconcile(phase = '') {
    updateGain();
    if (effectiveMuted()) {
      disarmAudioUnlock();
      closeTransport();
      render(phase);
      return;
    }
    if (!audioGraphReady()) {
      armAudioUnlock();
      render(phase || 'first-interaction');
      return;
    }
    if (!audioRendering()) {
      startResume(audioContext);
      armAudioUnlock();
      if (audioEverRunning) {
        audioInterruption.begin();
        ensureTransport('interrupted');
        return;
      }
      render('first-interaction');
      return;
    }

    if (audioEverRunning) finishAudioInterruptionEvidence();
    audioEverRunning = true;
    stalledResumeGestures = 0;
    disarmAudioUnlock();
    if (liveEdgeRecoveryRequired) {
      restartMonitorAtLiveEdge();
      return;
    }
    ensureTransport(phase || 'connecting');
  }

  function forceMicMute(phase = 'mic-active') {
    micMuteEpoch += 1;
    micForcedMuted = true;
    reconcile(phase);
  }

  function restoreAfterMic(phase = 'resumed') {
    micForcedMuted = false;
    if (roomMicForcedMuted) {
      reconcile('mic-owned');
      return;
    }
    if (playbackForcedMuted) {
      reconcile('song-owned');
      return;
    }
    if (takeReviewForcedMuted) {
      reconcile('take-review');
      return;
    }
    if (userMuted) {
      reconcile('user-muted');
      return;
    }
    reconcile(phase);
  }

  function restoreAfterMicBoundary(phase = 'resumed') {
    // Legacy terminal notifications can be dispatched immediately before
    // app.js enters stop(). Defer one task so stop() has synchronously stopped
    // MediaStream tracks before room audio can become audible again. Fence the
    // deferred restore to this Mic transition: a new Mic request in the same
    // turn must not be unmuted by the previous session's stale timer.
    const restoreEpoch = micMuteEpoch;
    setTimeout(() => {
      if (micMuteEpoch !== restoreEpoch) return;
      claimMicrophoneAudio(false);
      restoreAfterMic(phase);
    }, 0);
  }

  function setRoomMicForcedMute(forced) {
    if (roomMicForcedMuted === forced) return;
    roomMicForcedMuted = forced;
    if (forced) {
      reconcile('mic-owned');
      return;
    }
    if (micForcedMuted) {
      reconcile('mic-starting');
      return;
    }
    if (playbackForcedMuted) {
      reconcile('song-owned');
      return;
    }
    if (takeReviewForcedMuted) {
      reconcile('take-review');
      return;
    }
    if (userMuted) {
      reconcile('user-muted');
      return;
    }
    reconcile('resumed');
  }

  function setPlaybackForcedMute(forced) {
    if (playbackForcedMuted === forced) return;
    playbackForcedMuted = forced;
    if (forced) {
      reconcile('song-owned');
      return;
    }
    if (micForcedMuted || roomMicForcedMuted) {
      reconcile('mic-owned');
      return;
    }
    if (takeReviewForcedMuted) {
      reconcile('take-review');
      return;
    }
    if (userMuted) {
      reconcile('user-muted');
      return;
    }
    reconcile('resumed');
  }

  function setTakeReviewForcedMute(forced) {
    if (takeReviewForcedMuted === forced) return;
    takeReviewForcedMuted = forced;
    // Take review is a local overlay just like Mic/holder feedback protection.
    // It must not rewrite the user's own mute preference; when review ends,
    // reconcile() resumes only if no other forced/user mute reason remains.
    reconcile(forced ? 'take-review' : 'resumed');
  }

  /**
   * Throws away a context that will not start, so the next one can.
   *
   * Safari can leave an AudioContext permanently unable to run: `resume()` is
   * accepted inside a real gesture, its promise never settles, and `state`
   * never leaves `suspended`. A successful running state resets the retry
   * budget, so a later OS interruption gets one real resume gesture before the
   * graph is replaced.
   */
  function discardStuckAudioGraph() {
    closeTransport();
    const stuck = audioContext;
    audioContext = null;
    playbackNode = null;
    gainNode = null;
    audioSetupPromise = null;
    audioEverRunning = false;
    liveEdgeRecoveryRequired = false;
    audioInterruption.reset();
    stalledResumeGestures = 0;
    if (stuck) {
      try { void stuck.close(); } catch {}
    }
  }

  async function activateFromGesture() {
    if (audioContext && !audioRendering() && !effectiveMuted()) {
      if (stalledResumeGestures >= 1) {
        discardStuckAudioGraph();
      } else {
        stalledResumeGestures = 1;
        resumeAudioGraph();
      }
    }
    try {
      await ensureAudioGraph();
      reconcile();
      if (audioContext && !audioRendering() && !effectiveMuted()) {
        stalledResumeGestures = Math.max(1, stalledResumeGestures);
      }
    } catch (error) {
      console.error(error);
      armAudioUnlock();
      render('retry');
    }
  }

  toggle.addEventListener('click', async () => {
    if (micForcedMuted || roomMicForcedMuted || playbackForcedMuted || takeReviewForcedMuted) return;
    userMuted = !userMuted;
    claimPlaybackAudio(!userMuted);
    if (!userMuted) {
      try {
        await ensureAudioGraph();
      } catch (error) {
        console.error(error);
        userMuted = true;
        claimPlaybackAudio(false);
        render('start-failed');
        return;
      }
    }
    reconcile();
  });

  gainControl.addEventListener('input', () => {
    updateGain();
    render('volume-change');
  });

  // Presence owns whether the primary Mic action is an ordinary request or a
  // takeover. Listen consumes that state directly rather than reading a DOM
  // label written by the Mic presenter.
  window.addEventListener('relay-mic-action-state', (event) => {
    micPrimaryMode = event.detail?.primaryMode === 'takeover' ? 'takeover' : 'microphone';
  });

  // Product semantics are negative: room audio is wanted by default, while
  // local source roles temporarily overlay forced mute reasons. Do not rewrite
  // the user's own mute preference when Mic or Song ownership comes and goes.
  // The capture-phase AudioSession claim happens before app.js starts
  // getUserMedia(), so iOS enters play-and-record before opening the input.
  publisherButton.addEventListener('click', () => {
    if (micPrimaryMode !== 'takeover') {
      claimMicrophoneAudio(true);
      forceMicMute('mic-starting');
    }
  }, { capture: true });
  takeoverButton.addEventListener('click', () => {
    claimMicrophoneAudio(true);
    forceMicMute('handoff-starting');
  }, { capture: true });
  window.addEventListener('relay-request-microphone', () => {
    claimMicrophoneAudio(true);
    forceMicMute('handoff-starting');
  }, { capture: true });
  window.addEventListener('relay-microphone-started', () => {
    claimMicrophoneAudio(true);
    forceMicMute('mic-owned');
  });
  window.addEventListener('relay-microphone-ended', () => {
    restoreAfterMicBoundary();
  });
  window.addEventListener('relay-microphone-start-failed', () => {
    restoreAfterMicBoundary('mic-failed-resume');
  });

  function applyRoomSessionStatus(status) {
    const participantId = typeof window.relayParticipantId === 'string'
      ? window.relayParticipantId
      : null;
    const ownerId = typeof status?.micOwnerId === 'string'
      ? status.micOwnerId
      : null;
    setRoomMicForcedMute(Boolean(participantId && ownerId === participantId));
  }

  window.addEventListener('relay-session-status', (event) => applyRoomSessionStatus(event.detail));
  // Presence may have received its first snapshot before this module loaded.
  // Request an immediate replay so initial multi-tab ownership cannot race the
  // listener registration above.
  window.dispatchEvent(new Event('relay-request-session-status'));

  window.addEventListener('relay:playback-view', (event) => {
    setPlaybackForcedMute(shouldForceMuteListen({
      role: event.detail?.role,
      timeline: event.detail?.timeline,
    }));
  });
  window.addEventListener('relay-take-review-playback', (event) => {
    setTakeReviewForcedMute(event.detail?.active === true);
  });

  // Browsers do not generally allow a newly navigated page to speak before a
  // user gesture. Keep the gate armed until AudioContext itself reports
  // `running`; requesting resume is not enough evidence that sound can play.
  armAudioUnlock();

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') recoverAudioGraph();
  });
  window.addEventListener('pageshow', recoverAudioGraph);

  window.addEventListener('beforeunload', () => {
    disarmAudioUnlock();
    closeTransport();
    claimPlaybackAudio(false);
    claimMicrophoneAudio(false);
    if (audioContext) {
      try { audioContext.close(); } catch {}
    }
  }, { once: true });

  updateGain();
  render('first-interaction');
}