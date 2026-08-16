const t = (key, vars) => window.relayI18n?.t(key, vars) ?? key;
const recordButton = document.querySelector('#start-recording');
const stopButton = document.querySelector('#stop-recording');
const recordingStatus = document.querySelector('#recording-status');
const recordingPlayer = document.querySelector('#recording-player');
const recordingDownload = document.querySelector('#download-recording');

const RECONNECT_MS = 1_000;

let socket = null;
let reconnectTimer = null;
let latestStatus = { lifecycle: 'idle', take: null };
let commandError = null;
let productCanStartTake = false;

function wsUrl() {
  const participantId = typeof window.relayParticipantId === 'string'
    ? window.relayParticipantId
    : '';
  if (!participantId) return null;

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const source = new URLSearchParams(location.search);
  const params = new URLSearchParams();
  const key = source.get('key');
  if (key) params.set('key', key);
  params.set('participant', participantId);
  params.set('name', typeof window.relayNickname === 'string' ? window.relayNickname : 'Guest');
  return `${protocol}//${location.host}/ws?${params.toString()}`;
}

function artifactUrl(relativeUrl) {
  const url = new URL(relativeUrl, location.origin);
  const key = new URLSearchParams(location.search).get('key');
  if (key) url.searchParams.set('key', key);
  return url.toString();
}

function formatDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.round(Number(durationMs) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function elapsedDuration(startedAtMs) {
  if (!Number.isFinite(Number(startedAtMs))) return '0:00';
  return formatDuration(Date.now() - Number(startedAtMs));
}

function shortTakeId(takeId) {
  return typeof takeId === 'string' ? takeId.slice(0, 8) : '—';
}

function verdictLabel(verdict) {
  if (verdict === 'clean') return t('take.verdict.clean');
  if (verdict === 'review') return t('take.verdict.review');
  if (verdict === 'degraded') return t('take.verdict.degraded');
  return t('take.verdict.ready');
}

function render() {
  const lifecycle = String(latestStatus?.lifecycle ?? 'idle');
  const take = latestStatus?.take ?? null;
  const connected = socket?.readyState === WebSocket.OPEN;

  recordButton.disabled = !connected
    || !productCanStartTake
    || lifecycle === 'recording'
    || lifecycle === 'finalizing';
  stopButton.disabled = !connected || lifecycle !== 'recording' || !take?.takeId;

  // The formal Live surface keeps the completed Take as one lightweight entry.
  // Technical WAV details belong below Diagnostics, not in the singing view.
  recordingPlayer.hidden = true;
  recordingPlayer.removeAttribute('src');
  if (lifecycle !== 'ready') {
    recordingDownload.hidden = true;
    recordingDownload.removeAttribute('href');
  }

  if (commandError) {
    recordingStatus.textContent = commandError;
    return;
  }

  if (lifecycle === 'recording' && take) {
    recordingStatus.textContent = `● ${elapsedDuration(take.startedAtMs)}`;
    return;
  }

  if (lifecycle === 'finalizing' && take) {
    recordingStatus.textContent = t('take.finishing');
    return;
  }

  if (lifecycle === 'ready' && take?.artifact) {
    const href = artifactUrl(take.artifact.url);
    recordingDownload.href = href;
    recordingDownload.removeAttribute('download');
    recordingDownload.textContent = t('take.last', { duration: formatDuration(take.artifact.durationMs), verdict: verdictLabel(take.quality?.verdict) });
    recordingDownload.hidden = false;
    recordingStatus.textContent = '';
    return;
  }

  if (lifecycle === 'failed' && take) {
    recordingStatus.textContent = t('take.failed', { id: shortTakeId(take.takeId) });
    return;
  }

  recordingStatus.textContent = '';
}

function send(payload) {
  if (socket?.readyState !== WebSocket.OPEN) {
    commandError = t('take.reconnectingError');
    render();
    return false;
  }
  commandError = null;
  socket.send(JSON.stringify(payload));
  return true;
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
  const url = wsUrl();
  if (!url) {
    scheduleReconnect();
    return;
  }

  clearReconnect();
  const next = new WebSocket(url);
  socket = next;
  render();

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
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    if (message.type === 'take-status') {
      latestStatus = message;
      commandError = null;
      render();
      return;
    }

    if (message.type === 'take-command-rejected') {
      const key = `take.reject.${message.reason}`;
      commandError = window.relayI18n?.has?.(key)
        ? t(key)
        : t('take.reject.unknown', { reason: message.reason ?? 'unknown' });
      render();
    }
  });

  next.addEventListener('close', () => {
    if (socket !== next) return;
    socket = null;
    render();
    scheduleReconnect();
  });
  next.addEventListener('error', () => {
    try { next.close(); } catch {}
  });

  next.send(JSON.stringify({ type: 'take-status-request' }));
  render();
}

window.addEventListener('relay-locale-changed', render);

window.addEventListener('relay-product-status', (event) => {
  productCanStartTake = event.detail?.actions?.canStartTake === true;
  render();
});

recordButton.addEventListener('click', () => {
  send({ type: 'start-take' });
});

stopButton.addEventListener('click', () => {
  const takeId = latestStatus?.take?.takeId;
  if (!takeId) return;
  send({ type: 'stop-take', takeId });
});

setInterval(() => {
  if (latestStatus?.lifecycle === 'recording') render();
}, 1_000);

recordButton.disabled = true;
stopButton.disabled = true;
render();
connect().catch(scheduleReconnect);
