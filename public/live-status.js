import { sendParticipantAuthentication } from './participant-auth.js';
await window.relayIdentityReady;
const t = (key, vars) => window.relayI18n?.t(key, vars) ?? key;
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
  let latestProductStatus = null;

  const attentionLabels = {
    'audio-unavailable': () => t('system.attention.audio-unavailable'),
    'robot-audio-unavailable': () => t('system.attention.robot-audio-unavailable'),
    'robot-route-invalid': () => t('system.attention.robot-route-invalid'),
    'robot-player-unavailable': () => t('system.attention.robot-player-unavailable'),
    'song-clock-unavailable': () => t('system.attention.song-clock-unavailable'),
    'mic-reconnecting': () => t('system.attention.mic-reconnecting'),
    'mic-audio-stalled': () => t('system.attention.mic-audio-stalled'),
    'timing-recovering': () => t('system.attention.timing-recovering'),
    'timing-clamped': () => t('system.attention.timing-clamped'),
    'take-failed': () => t('system.attention.take-failed'),
  };

  const timingLabels = {
    idle: () => t('system.idle'),
    calibrating: () => t('system.timing.gettingReady'),
    aligned: () => t('system.timing.aligned'),
    fallback: () => t('system.timing.recovering'),
    stale: () => t('system.timing.recovering'),
    clamped: () => t('system.needsAttention'),
  };

  const takeLabels = {
    idle: () => t('system.take.available'),
    recording: () => t('system.take.recording'),
    finalizing: () => t('system.take.finishing'),
    ready: () => t('system.take.lastReady'),
    failed: () => t('system.needsAttention'),
  };

  function microphoneFailureCopy(rawMessage) {
    const message = typeof rawMessage === 'string' ? rawMessage.trim() : '';
    if (/https/i.test(message)) {
      return t('voice.httpsRequired');
    }
    if (/permission|notallowed|denied/i.test(message)) {
      return t('voice.permissionRequired');
    }
    return message || t('voice.checkAccess');
  }

  function wsUrl() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const source = new URLSearchParams(location.search);
    const params = new URLSearchParams();
    const key = source.get('key');
    if (key) params.set('key', key);

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
          title: t('voice.gettingReady'),
          detail: t('voice.keepSpeakerAudible'),
        };
      }
      if (song.state === 'handoff') {
        return {
          title: t('voice.songPreparing'),
          detail: selfOwner ? t('voice.playbackMovingHere') : t('voice.playbackChangingPhones'),
        };
      }
      return { title: t('voice.gettingReady'), detail: '' };
    }

    if (mic.state === 'free') {
      if (song.state === 'empty') {
        return { title: t('voice.micFree'), detail: t('voice.addSongToBegin') };
      }
      if (status.lifecycle === 'ready') {
        return { title: t('voice.ready'), detail: t('voice.takeMicWhenReady') };
      }
      return { title: t('voice.micFree'), detail: '' };
    }

    if (selfOwner) {
      if (mic.state === 'starting') {
        return { title: t('voice.startingYours'), detail: t('voice.waitingFirstAudio') };
      }
      if (mic.state === 'interrupted') {
        return { title: t('voice.interruptedYours'), detail: t('voice.mediaConnectedAudioStopped') };
      }
      if (mic.state === 'reconnecting') {
        return { title: t('voice.reconnectingYours'), detail: t('voice.holdingPlace') };
      }
      if (status.timing?.state === 'fallback' || status.timing?.state === 'stale') {
        return { title: t('voice.live'), detail: t('voice.timingRecovering') };
      }
      if (song.state === 'playing') {
        return { title: t('voice.live'), detail: t('voice.useHeadphones') };
      }
      return { title: t('voice.live'), detail: t('voice.toRoom') };
    }

    const owner = mic.ownerNickname || t('voice.someone');
    if (mic.state === 'starting') {
      return { title: owner, detail: t('voice.startingOther') };
    }
    if (mic.state === 'interrupted') {
      return { title: owner, detail: t('voice.interruptedOther') };
    }
    if (mic.state === 'reconnecting') {
      return { title: owner, detail: t('voice.reconnecting') };
    }
    return { title: owner, detail: t('voice.singing') };
  }

  function renderSystem(status) {
    const attention = status.attention;
    const robotProblem = attention?.scope === 'robot';
    const audioProblem = attention?.scope === 'audio' || attention?.scope === 'song';
    const songState = status.room?.song?.state;
    const micState = status.room?.mic?.state;

    systemRelay.textContent = socket?.readyState === WebSocket.OPEN ? t('system.connected') : t('system.reconnecting');
    const people = Number(status.room?.participantCount) || 0;
    systemPhones.textContent = t('system.people', { count: people, label: t(people === 1 ? 'system.person' : 'system.peoplePlural') });
    systemRobot.textContent = robotProblem
      ? t('system.needsAttention')
      : status.lifecycle === 'idle' && songState === 'empty'
        ? t('system.idle')
        : t('system.ok');
    systemAudio.textContent = audioProblem
      ? t('system.needsAttention')
      : songState === 'playing' || micState === 'live'
        ? t('system.live')
        : micState === 'starting'
          ? t('system.starting')
          : micState === 'interrupted' || micState === 'reconnecting'
            ? t('system.recovering')
            : songState === 'ready' || songState === 'handoff'
            ? t('system.ready')
            : songState === 'unavailable'
              ? t('system.needsAttention')
              : t('system.idle');
    systemTiming.textContent = timingLabels[status.timing?.state]?.() ?? t('system.unknown');
    systemRecording.textContent = takeLabels[status.take?.lifecycle]?.() ?? t('system.unknown');
  }

  function renderAttention(status) {
    const attention = status.attention;
    if (!attention) {
      attentionRegion.hidden = true;
      attentionCopy.textContent = '';
      return;
    }
    attentionCopy.textContent = attentionLabels[attention.code]?.() ?? t('system.attention');
    attentionRegion.hidden = false;
    attentionRegion.dataset.scope = attention.scope || '';
    attentionRegion.dataset.severity = attention.severity || 'warning';
  }

  function render(status) {
    if (!status || status.type !== 'product-status') return;
    latestProductStatus = status;
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
      systemRelay.textContent = t('system.reconnecting');
      scheduleReconnect();
    });
    next.addEventListener('error', () => {
      try { next.close(); } catch {}
    });

    sendParticipantAuthentication(next);
    next.send(JSON.stringify({ type: 'product-status-request' }));
  }

  window.addEventListener('relay-microphone-start-failed', (event) => {
    title.textContent = t('voice.micUnavailable');
    detail.textContent = microphoneFailureCopy(event.detail?.message);
    document.body.dataset.selfMic = 'off';
  });

  attentionButton.addEventListener('click', () => {
    systemPanel.open = true;
    systemPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  window.addEventListener('relay-locale-changed', () => {
    if (latestProductStatus) render(latestProductStatus);
  });

  connect().catch(scheduleReconnect);
}