import { sendParticipantAuthentication } from './participant-auth.js';
await window.relayIdentityReady;
import { shouldForceMuteListen } from './playback-recovery.js';

const t = (key, vars) => window.relayI18n?.t(key, vars) ?? key;
const toggle = document.querySelector('#listen-toggle');
const gainControl = document.querySelector('#listen-gain');
const gainValue = document.querySelector('#listen-gain-value');
const note = document.querySelector('#listen-note');
const adjustState = document.querySelector('#listen-adjust-state');
const publisherButton = document.querySelector('#start-publisher');
const takeoverButton = document.querySelector('#confirm-takeover');

if (toggle && gainControl && gainValue && note && adjustState && publisherButton && takeoverButton) {
  const MIX_SAMPLE_RATE = 48_000;
  const RECONNECT_MS = 1_000;
  const PREBUFFER_MS = 250;
  const MAX_QUEUE_MS = 800;

  let socket = null;
  let pendingSocket = null;
  let transportEpoch = 0;
  let reconnectTimer = null;
  let audioContext = null;
  let playbackNode = null;
  let gainNode = null;
  let audioSetupPromise = null;
  let audioUnlockArmed = false;
  let transportEnabled = false;
  let userMuted = false;
  let micForcedMuted = false;
  let micMuteEpoch = 0;
  let roomMicForcedMuted = false;
  let playbackForcedMuted = false;
  let sourceSampleRate = MIX_SAMPLE_RATE;

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

  function listenGain() {
    const percent = Math.max(0, Math.min(100, Number(gainControl.value) || 0));
    if (percent === 0) return 0;
    // Keep local playback at or below unity. The server mix is already
    // full-scale limited; multiplying it again here would create phone-only clipping.
    return (percent / 100) ** 1.5;
  }

  function effectiveMuted() {
    return userMuted || micForcedMuted || roomMicForcedMuted || playbackForcedMuted;
  }

  function audioReady() {
    return Boolean(
      audioContext
      && playbackNode
      && gainNode
      && audioContext.state === 'running'
    );
  }

  function forcedMuteReason() {
    if (micForcedMuted || roomMicForcedMuted) return 'mic';
    if (playbackForcedMuted) return 'playback';
    return null;
  }

  function updateGain() {
    const percent = Math.round(Number(gainControl.value) || 0);
    gainValue.value = `${percent}%`;
    if (gainNode && audioContext) {
      const target = effectiveMuted() ? 0 : listenGain();
      gainNode.gain.setTargetAtTime(target, audioContext.currentTime, 0.01);
    }
  }

  function render(copy = '') {
    const muted = effectiveMuted();
    const forcedReason = forcedMuteReason();
    const state = forcedReason === 'mic'
      ? 'mic-muted'
      : forcedReason === 'playback'
        ? 'playback-muted'
        : userMuted
          ? 'muted'
          : audioReady()
            ? 'audible'
            : 'ready';
    toggle.dataset.state = state;
    toggle.setAttribute('aria-pressed', muted ? 'true' : 'false');
    toggle.disabled = Boolean(forcedReason);
    toggle.textContent = forcedReason === 'mic'
      ? t('listen.mutedForMic')
      : forcedReason === 'playback'
        ? t('listen.mutedForSong')
        : userMuted
          ? t('listen.unmute')
          : t('listen.mute');
    note.textContent = copy;
    document.body.dataset.listen = state;

    if (forcedReason === 'mic') {
      adjustState.textContent = t('listen.adjust.micMuted');
    } else if (forcedReason === 'playback') {
      adjustState.textContent = t('listen.adjust.songMuted');
    } else if (userMuted) {
      adjustState.textContent = t('listen.adjust.userMuted');
    } else if (!audioReady()) {
      adjustState.textContent = copy || t('listen.adjust.ready');
    } else if (transportEnabled) {
      adjustState.textContent = t('listen.adjust.playing');
    } else {
      adjustState.textContent = copy || t('listen.connectingAudio');
    }
  }

  function clearReconnect() {
    if (!reconnectTimer) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function closeTransport() {
    transportEnabled = false;
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
    playbackNode?.port.postMessage({ type: 'reset' });
  }

  function scheduleReconnect() {
    if (!transportEnabled || effectiveMuted() || !audioReady() || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect().catch(() => {
        if (!transportEnabled || effectiveMuted() || !audioReady()) return;
        render(t('listen.reconnecting'));
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
      || effectiveMuted()
      || !audioReady()
      || pendingSocket
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

    if (connectEpoch !== transportEpoch || !transportEnabled || effectiveMuted() || !audioReady()) {
      next.close();
      return;
    }

    const previous = socket;
    socket = next;
    if (previous && previous !== next) {
      try { previous.close(); } catch {}
    }
    playbackNode.port.postMessage({ type: 'reset' });
    sendParticipantAuthentication(next);
    next.send(JSON.stringify({ type: 'register', role: 'monitor' }));

    next.addEventListener('message', (event) => {
      if (socket !== next || connectEpoch !== transportEpoch) return;
      if (typeof event.data === 'string') {
        try { handleMessage(JSON.parse(event.data)); } catch {}
        return;
      }
      if (!(event.data instanceof ArrayBuffer) || !audioReady()) return;
      const pcm = int16ToFloat32(event.data);
      const samples = linearResample(pcm, sourceSampleRate, audioContext.sampleRate);
      playbackNode.port.postMessage(samples.buffer, [samples.buffer]);
    });

    next.addEventListener('close', () => {
      if (socket !== next || connectEpoch !== transportEpoch) return;
      socket = null;
      if (!transportEnabled || effectiveMuted() || !audioReady()) return;
      render(t('listen.reconnecting'));
      scheduleReconnect();
    });
    next.addEventListener('error', () => {
      try { next.close(); } catch {}
    });
  }

  /**
   * Requests a resume without giving anything the chance to wait on it.
   *
   * See ensureAudioGraph: on iOS Safari this promise can stay pending for the
   * life of the page. Callers may only ever fire it and move on.
   */
  function startResume(context) {
    if (!context || context.state !== 'suspended') return;
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
    if (audioUnlockArmed || effectiveMuted() || audioReady()) return;
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
    reconcile();
  }

  async function ensureAudioGraph() {
    if (audioContext && playbackNode && gainNode) {
      resumeAudioGraph();
      return;
    }
    if (audioSetupPromise) return audioSetupPromise;

    audioSetupPromise = (async () => {
      const context = new AudioContext({ latencyHint: 'interactive' });
      audioContext = context;
      context.addEventListener('statechange', () => {
        if (audioContext !== context) return;
        if (context.state === 'running') {
          disarmAudioUnlock();
        } else if (!effectiveMuted()) {
          armAudioUnlock();
        }
        reconcile();
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
      //
      // A resume request is not proof that playback started. If the context
      // remains suspended, reconcile() keeps the transport closed and the
      // gesture gate armed until a later real user interaction gets it running.
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
        if (!transportEnabled || effectiveMuted() || !audioReady()) return;
        if (event.data?.type === 'buffering') render(t('listen.buffering'));
        if (event.data?.type === 'playing') render('');
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
      try { await failed?.close(); } catch {}
      throw error;
    } finally {
      audioSetupPromise = null;
    }
  }

  function reconcile(copy = '') {
    updateGain();
    if (effectiveMuted()) {
      disarmAudioUnlock();
      closeTransport();
      render(copy);
      return;
    }
    if (!audioContext || !playbackNode || !gainNode) {
      armAudioUnlock();
      render(copy || t('listen.firstInteraction'));
      return;
    }
    if (audioContext.state !== 'running') {
      closeTransport();
      armAudioUnlock();
      render(t('listen.firstInteraction'));
      return;
    }

    disarmAudioUnlock();
    if (transportEnabled) {
      render(copy);
      return;
    }

    transportEnabled = true;
    render(copy || t('people.connecting'));
    connect().catch(() => {
      if (!transportEnabled || effectiveMuted() || !audioReady()) return;
      render(t('listen.reconnecting'));
      scheduleReconnect();
    });
  }

  function forceMicMute(copy = t('listen.micActive')) {
    micMuteEpoch += 1;
    micForcedMuted = true;
    reconcile(copy);
  }

  function restoreAfterMic(copy = t('listen.resumed')) {
    micForcedMuted = false;
    if (roomMicForcedMuted) {
      reconcile(t('listen.micOwned'));
      return;
    }
    if (playbackForcedMuted) {
      reconcile(t('listen.songOwned'));
      return;
    }
    if (userMuted) {
      reconcile(t('listen.adjust.userMuted'));
      return;
    }
    reconcile(copy);
  }

  function restoreAfterMicBoundary(copy = t('listen.resumed')) {
    // Legacy terminal notifications can be dispatched immediately before
    // app.js enters stop(). Defer one task so stop() has synchronously stopped
    // MediaStream tracks before room audio can become audible again. Fence the
    // deferred restore to this Mic transition: a new Mic request in the same
    // turn must not be unmuted by the previous session's stale timer.
    const restoreEpoch = micMuteEpoch;
    setTimeout(() => {
      if (micMuteEpoch !== restoreEpoch) return;
      restoreAfterMic(copy);
    }, 0);
  }

  function setRoomMicForcedMute(forced) {
    if (roomMicForcedMuted === forced) return;
    roomMicForcedMuted = forced;
    if (forced) {
      reconcile(t('listen.micOwned'));
      return;
    }
    if (micForcedMuted) {
      reconcile(t('listen.micStarting'));
      return;
    }
    if (playbackForcedMuted) {
      reconcile(t('listen.songOwned'));
      return;
    }
    if (userMuted) {
      reconcile(t('listen.adjust.userMuted'));
      return;
    }
    reconcile(t('listen.resumed'));
  }

  function setPlaybackForcedMute(forced) {
    if (playbackForcedMuted === forced) return;
    playbackForcedMuted = forced;
    if (forced) {
      reconcile(t('listen.songOwned'));
      return;
    }
    if (micForcedMuted || roomMicForcedMuted) {
      reconcile(t('listen.micOwned'));
      return;
    }
    if (userMuted) {
      reconcile(t('listen.adjust.userMuted'));
      return;
    }
    reconcile(t('listen.resumed'));
  }

  async function activateFromGesture() {
    // A gesture primes the Listen graph and, while the browser still keeps the
    // context suspended, remains a retry opportunity. Only a real running
    // AudioContext lets reconcile() open the monitor transport.
    try {
      await ensureAudioGraph();
      reconcile();
    } catch (error) {
      console.error(error);
      armAudioUnlock();
      render(t('listen.retry'));
    }
  }

  toggle.addEventListener('click', async () => {
    if (micForcedMuted || roomMicForcedMuted || playbackForcedMuted) return;
    userMuted = !userMuted;
    if (!userMuted) {
      try {
        await ensureAudioGraph();
      } catch (error) {
        console.error(error);
        userMuted = true;
        render(t('listen.startFailed'));
        return;
      }
    }
    reconcile();
  });

  gainControl.addEventListener('input', updateGain);

  // Product semantics are negative: room audio is wanted by default, while
  // local source roles temporarily overlay forced mute reasons. Do not rewrite
  // the user's own mute preference when Mic or Song ownership comes and goes.
  publisherButton.addEventListener('click', () => {
    if (publisherButton.dataset.presenceLabel !== 'takeover') {
      forceMicMute(t('listen.micStarting'));
    }
  }, { capture: true });
  takeoverButton.addEventListener('click', () => forceMicMute(t('listen.handoffStarting')), { capture: true });
  window.addEventListener('relay-request-microphone', () => forceMicMute(t('listen.handoffStarting')));
  window.addEventListener('relay-microphone-started', () => forceMicMute(t('listen.micOwned')));
  window.addEventListener('relay-microphone-ended', () => restoreAfterMicBoundary());
  window.addEventListener('relay-microphone-start-failed', () => restoreAfterMicBoundary(t('listen.micFailedResume')));

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
    if (audioContext) {
      try { audioContext.close(); } catch {}
    }
  }, { once: true });

  window.addEventListener('relay-locale-changed', () => render());

  updateGain();
  render(t('listen.firstInteraction'));
}
