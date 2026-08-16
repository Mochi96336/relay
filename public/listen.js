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
  let reconnectTimer = null;
  let audioContext = null;
  let playbackNode = null;
  let gainNode = null;
  let audioSetupPromise = null;
  let transportEnabled = false;
  let userMuted = false;
  let micForcedMuted = false;
  let playbackForcedMuted = false;
  let sourceSampleRate = MIX_SAMPLE_RATE;

  function wsUrl() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const source = new URLSearchParams(location.search);
    const params = new URLSearchParams();
    const key = source.get('key');
    if (key) params.set('key', key);

    const participantId = typeof window.relayParticipantId === 'string'
      ? window.relayParticipantId.trim()
      : '';
    const nickname = typeof window.relayNickname === 'string'
      ? window.relayNickname.trim()
      : '';
    if (participantId && nickname) {
      params.set('participant', participantId);
      params.set('name', nickname);
    }

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
    // A curved local volume control preserves useful headroom for quiet phone
    // speakers without exposing the old engineering dB control in Live UI.
    return ((percent / 100) ** 1.5) * 8;
  }

  function effectiveMuted() {
    return userMuted || micForcedMuted || playbackForcedMuted;
  }

  function forcedMuteReason() {
    if (micForcedMuted) return 'mic';
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
          : audioContext
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
    } else if (!audioContext) {
      adjustState.textContent = t('listen.adjust.ready');
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
    clearReconnect();
    const closing = socket;
    socket = null;
    if (closing) {
      try { closing.close(); } catch {}
    }
    playbackNode?.port.postMessage({ type: 'reset' });
  }

  function scheduleReconnect() {
    if (!transportEnabled || effectiveMuted() || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect().catch(() => {
        if (!transportEnabled || effectiveMuted()) return;
        render(t('listen.reconnecting'));
        scheduleReconnect();
      });
    }, RECONNECT_MS);
  }

  function handleMessage(message) {
    if (message.type === 'source-status') {
      sourceSampleRate = Number(message.sampleRate ?? message.mixSampleRate) || MIX_SAMPLE_RATE;
    }
  }

  async function connect() {
    if (!transportEnabled || effectiveMuted() || !audioContext || !playbackNode) return;
    const next = new WebSocket(wsUrl());
    next.binaryType = 'arraybuffer';
    await new Promise((resolve, reject) => {
      next.addEventListener('open', resolve, { once: true });
      next.addEventListener('error', reject, { once: true });
    });

    if (!transportEnabled || effectiveMuted()) {
      next.close();
      return;
    }

    socket = next;
    playbackNode.port.postMessage({ type: 'reset' });
    next.send(JSON.stringify({ type: 'register', role: 'monitor' }));

    next.addEventListener('message', (event) => {
      if (socket !== next) return;
      if (typeof event.data === 'string') {
        try { handleMessage(JSON.parse(event.data)); } catch {}
        return;
      }
      if (!(event.data instanceof ArrayBuffer) || !audioContext || !playbackNode) return;
      const pcm = int16ToFloat32(event.data);
      const samples = linearResample(pcm, sourceSampleRate, audioContext.sampleRate);
      playbackNode.port.postMessage(samples.buffer, [samples.buffer]);
    });

    next.addEventListener('close', () => {
      if (socket !== next) return;
      socket = null;
      if (!transportEnabled || effectiveMuted()) return;
      render(t('listen.reconnecting'));
      scheduleReconnect();
    });
    next.addEventListener('error', () => {
      try { next.close(); } catch {}
    });
  }

  async function ensureAudioGraph() {
    if (audioContext && playbackNode && gainNode) {
      if (audioContext.state === 'suspended') await audioContext.resume();
      return;
    }
    if (audioSetupPromise) return audioSetupPromise;

    audioSetupPromise = (async () => {
      const context = new AudioContext({ latencyHint: 'interactive' });
      audioContext = context;
      // Consume the user's first interaction immediately. Fetching the worklet
      // before resume can lose transient autoplay permission on mobile.
      await context.resume();
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
        if (!transportEnabled || effectiveMuted()) return;
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
      closeTransport();
      render(copy);
      return;
    }
    if (!audioContext || !playbackNode || !gainNode) {
      render(copy || t('listen.firstInteraction'));
      return;
    }
    if (transportEnabled) {
      render(copy);
      return;
    }

    transportEnabled = true;
    render(copy || t('people.connecting'));
    connect().catch(() => {
      if (!transportEnabled || effectiveMuted()) return;
      render(t('listen.reconnecting'));
      scheduleReconnect();
    });
  }

  function forceMicMute(copy = t('listen.micActive')) {
    micForcedMuted = true;
    reconcile(copy);
  }

  function restoreAfterMic(copy = t('listen.resumed')) {
    micForcedMuted = false;
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

  function setPlaybackForcedMute(forced) {
    if (playbackForcedMuted === forced) return;
    playbackForcedMuted = forced;
    if (forced) {
      reconcile(t('listen.songOwned'));
      return;
    }
    if (micForcedMuted) {
      reconcile(t('listen.micOwned'));
      return;
    }
    if (userMuted) {
      reconcile(t('listen.adjust.userMuted'));
      return;
    }
    reconcile(t('listen.resumed'));
  }

  async function activateFromGesture(event) {
    const target = event.target instanceof Element ? event.target : null;
    const startsMic = target?.closest('#confirm-takeover')
      || (target?.closest('#start-publisher') && publisherButton.dataset.presenceLabel !== 'takeover');
    if (startsMic) micForcedMuted = true;
    try {
      await ensureAudioGraph();
      reconcile();
    } catch (error) {
      console.error(error);
      render(t('listen.retry'));
    }
  }

  toggle.addEventListener('click', async () => {
    if (micForcedMuted || playbackForcedMuted) return;
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
  window.addEventListener('relay-microphone-ended', () => restoreAfterMic());
  window.addEventListener('relay-microphone-start-failed', () => restoreAfterMic(t('listen.micFailedResume')));
  window.addEventListener('relay:playback-view', (event) => {
    const role = event.detail?.role;
    if (role === 'holder' || role === 'preparing') {
      setPlaybackForcedMute(true);
    } else if (role === 'observer' || role === 'empty') {
      setPlaybackForcedMute(false);
    }
  });

  // Browsers do not generally allow a newly navigated page to speak before a
  // user gesture. Prime the local graph on the first interaction, then the
  // default-unmuted state and later forced-mute restore can run without another tap.
  window.addEventListener('pointerdown', activateFromGesture, { capture: true, once: true });
  window.addEventListener('keydown', activateFromGesture, { capture: true, once: true });

  window.addEventListener('beforeunload', () => {
    closeTransport();
    if (audioContext) {
      try { audioContext.close(); } catch {}
    }
  }, { once: true });

  window.addEventListener('relay-locale-changed', () => render());

  updateGain();
  render(t('listen.firstInteraction'));
}
