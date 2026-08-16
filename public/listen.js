const toggle = document.querySelector('#listen-toggle');
const gainControl = document.querySelector('#listen-gain');
const gainValue = document.querySelector('#listen-gain-value');
const note = document.querySelector('#listen-note');
const adjustState = document.querySelector('#listen-adjust-state');

if (toggle && gainControl && gainValue && note && adjustState) {
  const MIX_SAMPLE_RATE = 48_000;
  const RECONNECT_MS = 1_000;
  const PREBUFFER_MS = 250;
  const MAX_QUEUE_MS = 800;

  let socket = null;
  let reconnectTimer = null;
  let audioContext = null;
  let playbackNode = null;
  let gainNode = null;
  let enabled = false;
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

  function updateGain() {
    const percent = Math.round(Number(gainControl.value) || 0);
    gainValue.value = `${percent}%`;
    if (gainNode && audioContext) {
      gainNode.gain.setTargetAtTime(listenGain(), audioContext.currentTime, 0.01);
    }
  }

  function render(state, copy = '') {
    toggle.dataset.state = state;
    toggle.setAttribute('aria-pressed', state === 'on' ? 'true' : 'false');
    toggle.textContent = state === 'on' ? '● Listen' : 'Listen';
    note.textContent = copy;
    document.body.dataset.listen = state;
    adjustState.textContent = state === 'on'
      ? 'Playing Relay mix on this phone.'
      : copy.includes('timing setup')
        ? 'Listen is off for timing setup. Volume is kept for next time.'
        : 'Listen is off. Volume is kept for next time.';
  }

  function clearReconnect() {
    if (!reconnectTimer) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function scheduleReconnect() {
    if (!enabled || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect().catch(() => {
        if (!enabled) return;
        render('on', 'Reconnecting…');
        scheduleReconnect();
      });
    }, RECONNECT_MS);
  }

  function handleMessage(message) {
    if (message.type === 'test-status' || message.type === 'source-status') {
      sourceSampleRate = Number(message.sampleRate ?? message.mixSampleRate) || MIX_SAMPLE_RATE;
      return;
    }

    // Timing setup only needs to silence the returned mix on the phone whose
    // microphone is being measured. Other participants may keep listening.
    // Do not auto-resume afterward; the singer explicitly turns Listen back on,
    // ideally after moving the output to headphones.
    if (
      message.type === 'timing-calibration-status'
      && message.state === 'collecting'
      && window.relayActiveRole === 'publisher'
    ) {
      void stop('Listen paused for timing setup.');
    }
  }

  async function connect() {
    if (!enabled || !audioContext || !playbackNode) return;
    const next = new WebSocket(wsUrl());
    next.binaryType = 'arraybuffer';
    await new Promise((resolve, reject) => {
      next.addEventListener('open', resolve, { once: true });
      next.addEventListener('error', reject, { once: true });
    });

    if (!enabled) {
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
      if (!enabled) return;
      render('on', 'Reconnecting…');
      scheduleReconnect();
    });
    next.addEventListener('error', () => {
      try { next.close(); } catch {}
    });
  }

  async function start() {
    if (enabled) return;
    enabled = true;
    clearReconnect();
    render('on', window.relayActiveRole === 'publisher'
      ? 'Use headphones while your mic is on.'
      : 'Listening on this phone.');

    audioContext = new AudioContext({ latencyHint: 'interactive' });
    await audioContext.audioWorklet.addModule('/playback-worklet.js');
    await audioContext.resume();

    playbackNode = new AudioWorkletNode(audioContext, 'playback-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    playbackNode.port.postMessage({
      type: 'configure',
      prebufferMs: PREBUFFER_MS,
      maxQueueMs: MAX_QUEUE_MS,
    });
    playbackNode.port.onmessage = (event) => {
      if (!enabled) return;
      if (event.data?.type === 'buffering') render('on', 'Buffering…');
      if (event.data?.type === 'playing') {
        render('on', window.relayActiveRole === 'publisher'
          ? 'Use headphones while your mic is on.'
          : 'Listening on this phone.');
      }
    };

    gainNode = audioContext.createGain();
    gainNode.gain.value = listenGain();
    playbackNode.connect(gainNode).connect(audioContext.destination);

    try {
      await connect();
    } catch {
      render('on', 'Reconnecting…');
      scheduleReconnect();
    }
  }

  async function stop(copy = '') {
    enabled = false;
    clearReconnect();
    const closing = socket;
    socket = null;
    if (closing) {
      try { closing.close(); } catch {}
    }
    if (playbackNode) {
      try { playbackNode.disconnect(); } catch {}
      playbackNode = null;
    }
    if (gainNode) {
      try { gainNode.disconnect(); } catch {}
      gainNode = null;
    }
    if (audioContext) {
      const closingContext = audioContext;
      audioContext = null;
      try { await closingContext.close(); } catch {}
    }
    render('off', copy);
  }

  toggle.addEventListener('click', () => {
    if (enabled) stop().catch(console.error);
    else start().catch((error) => {
      console.error(error);
      stop('Could not start Listen.').catch(console.error);
    });
  });

  gainControl.addEventListener('input', updateGain);
  window.addEventListener('relay-microphone-started', () => {
    if (enabled) render('on', 'Use headphones while your mic is on.');
  });
  window.addEventListener('beforeunload', () => {
    if (socket) {
      try { socket.close(); } catch {}
    }
  }, { once: true });

  updateGain();
  render('off');
}
