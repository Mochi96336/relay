const title = document.querySelector('#live-state-title');
const detail = document.querySelector('#live-state-detail');
const attentionRegion = document.querySelector('#system-attention');
const attentionButton = document.querySelector('#attention-link');
const attentionCopy = document.querySelector('#attention-copy');
const systemPanel = document.querySelector('#system-panel');
const systemRelay = document.querySelector('#system-relay');
const systemPhones = document.querySelector('#system-phones');
const systemRobot = document.querySelector('#system-robot');
const systemAudio = document.querySelector('#system-audio');
const systemTiming = document.querySelector('#system-timing');
const systemRecording = document.querySelector('#system-recording');

if (
  title && detail && attentionRegion && attentionButton && attentionCopy
  && systemPanel && systemRelay && systemPhones && systemRobot
  && systemAudio && systemTiming && systemRecording
) {
  const RECONNECT_MS = 1_000;
  let socket = null;
  let reconnectTimer = null;

  const attentionLabels = {
    'robot-audio-unavailable': 'Robot audio unavailable',
    'robot-route-invalid': 'Robot audio route needs attention',
    'robot-player-unavailable': 'Robot player unavailable',
    'song-clock-unavailable': 'Song playback unavailable',
    'mic-reconnecting': 'Microphone reconnecting',
    'timing-recovering': 'Timing is recovering',
    'timing-clamped': 'Timing needs attention',
    'take-failed': 'Take failed',
  };

  const timingLabels = {
    idle: 'Idle',
    calibrating: 'Getting ready',
    aligned: 'Aligned',
    fallback: 'Recovering',
    stale: 'Recovering',
    clamped: 'Needs attention',
  };

  const takeLabels = {
    idle: 'Available',
    recording: 'Recording',
    finalizing: 'Finishing',
    ready: 'Last take ready',
    failed: 'Needs attention',
  };

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

  function isSelfOwner(status) {
    return Boolean(
      status?.room?.mic?.ownerId
      && typeof window.relayParticipantId === 'string'
      && status.room.mic.ownerId === window.relayParticipantId,
    );
  }

  function liveCopy(status) {
    const mic = status.room?.mic ?? {};
    const song = status.room?.song ?? {};
    const selfOwner = isSelfOwner(status);

    if (status.lifecycle === 'preparing') {
      if (selfOwner && status.timing?.state === 'calibrating') {
        return {
          title: 'Getting ready…',
          detail: 'Keep this phone speaker audible for a moment.',
        };
      }
      if (song.state === 'handoff') {
        return {
          title: 'Getting the song ready…',
          detail: selfOwner ? 'Playback is moving to this phone.' : 'Playback is changing phones.',
        };
      }
      return { title: 'Getting ready…', detail: '' };
    }

    if (mic.state === 'free') {
      if (song.state === 'empty') {
        return { title: 'Mic is free', detail: 'Add a song to begin.' };
      }
      if (status.lifecycle === 'ready') {
        return { title: 'Ready when you are', detail: 'Take the mic when you want to sing.' };
      }
      return { title: 'Mic is free', detail: '' };
    }

    if (selfOwner) {
      if (mic.state === 'reconnecting') {
        return { title: 'Reconnecting your mic…', detail: 'Relay is holding your place for a moment.' };
      }
      if (status.timing?.state === 'fallback' || status.timing?.state === 'stale') {
        return { title: 'You’re live', detail: 'Timing is recovering while you keep singing.' };
      }
      return { title: 'You’re live', detail: 'Your voice is going to the room.' };
    }

    const owner = mic.ownerNickname || 'Someone';
    if (mic.state === 'reconnecting') {
      return { title: owner, detail: 'microphone reconnecting…' };
    }
    return { title: owner, detail: 'is singing' };
  }

  function renderSystem(status) {
    const attention = status.attention;
    const robotProblem = attention?.scope === 'robot';
    const songState = status.room?.song?.state;

    systemRelay.textContent = socket?.readyState === WebSocket.OPEN ? 'Connected' : 'Reconnecting';
    const people = Number(status.room?.participantCount) || 0;
    systemPhones.textContent = `${people} ${people === 1 ? 'person' : 'people'}`;
    systemRobot.textContent = robotProblem
      ? 'Needs attention'
      : status.lifecycle === 'idle' && songState === 'empty'
        ? 'Idle'
        : 'OK';
    systemAudio.textContent = songState === 'playing'
      ? 'Live'
      : songState === 'ready' || songState === 'handoff'
        ? 'Ready'
        : songState === 'unavailable'
          ? 'Needs attention'
          : 'Idle';
    systemTiming.textContent = timingLabels[status.timing?.state] ?? 'Unknown';
    systemRecording.textContent = takeLabels[status.take?.lifecycle] ?? 'Unknown';
  }

  function renderAttention(status) {
    const attention = status.attention;
    if (!attention) {
      attentionRegion.hidden = true;
      attentionCopy.textContent = '';
      return;
    }
    attentionCopy.textContent = attentionLabels[attention.code] ?? 'System needs attention';
    attentionRegion.hidden = false;
    attentionRegion.dataset.scope = attention.scope || '';
    attentionRegion.dataset.severity = attention.severity || 'warning';
  }

  function render(status) {
    if (!status || status.type !== 'product-status') return;
    const copy = liveCopy(status);
    title.textContent = copy.title;
    detail.textContent = copy.detail;

    const selfOwner = isSelfOwner(status);
    document.body.dataset.lifecycle = status.lifecycle || 'idle';
    document.body.dataset.health = status.health || 'healthy';
    document.body.dataset.timing = status.timing?.state || 'idle';
    document.body.dataset.selfMic = selfOwner && status.room?.mic?.state === 'live' ? 'live' : 'off';

    renderAttention(status);
    renderSystem(status);
    window.dispatchEvent(new CustomEvent('relay-product-status', { detail: status }));
  }

  function clearReconnect() {
    if (!reconnectTimer) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect().catch(scheduleReconnect);
    }, RECONNECT_MS);
  }

  async function connect() {
    if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
    clearReconnect();
    const next = new WebSocket(wsUrl());
    socket = next;

    await new Promise((resolve, reject) => {
      next.addEventListener('open', resolve, { once: true });
      next.addEventListener('error', reject, { once: true });
    });

    if (socket !== next) {
      next.close();
      return;
    }

    next.addEventListener('message', (event) => {
      if (socket !== next || typeof event.data !== 'string') return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'product-status') render(message);
    });

    next.addEventListener('close', () => {
      if (socket !== next) return;
      socket = null;
      systemRelay.textContent = 'Reconnecting';
      scheduleReconnect();
    });
    next.addEventListener('error', () => {
      try { next.close(); } catch {}
    });

    next.send(JSON.stringify({ type: 'product-status-request' }));
  }

  attentionButton.addEventListener('click', () => {
    systemPanel.open = true;
    systemPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  connect().catch(scheduleReconnect);
}
