import './take-history.js';
import { sendParticipantAuthentication } from './participant-auth.js';
await window.relayIdentityReady;
const t = (key, vars) => window.relayI18n?.t(key, vars) ?? key;
const recordButton = document.querySelector('#start-recording');
const stopButton = document.querySelector('#stop-recording');
const recordingStatus = document.querySelector('#recording-status');

const RECONNECT_MS = 1_000;

let socket = null;
let reconnectTimer = null;
let latestStatus = { lifecycle: 'idle', take: null, history: [] };
let commandError = null;
let productCanStartTake = false;

function wsUrl() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const source = new URLSearchParams(location.search);
  const params = new URLSearchParams();
  const key = source.get('key');
  if (key) params.set('key', key);
  const query = params.toString();
  return `${protocol}//${location.host}/ws${query ? `?${query}` : ''}`;
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

function publishTakeStatus(status) {
  window.dispatchEvent(new CustomEvent('relay-take-status', { detail: status }));
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

  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        next.removeEventListener('open', onOpen);
        next.removeEventListener('error', onError);
        next.removeEventListener('close', onClose);
      };
      const settle = (callback, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      };
      const onOpen = () => settle(resolve);
      const onError = () => settle(reject, new Error('Take WebSocket connection failed.'));
      const onClose = () => settle(reject, new Error('Take WebSocket closed before opening.'));
      next.addEventListener('open', onOpen);
      next.addEventListener('error', onError);
      next.addEventListener('close', onClose);
    });
  } catch (error) {
    if (socket === next) socket = null;
    try { next.close(); } catch {}
    render();
    throw error;
  }

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
      publishTakeStatus(message);
      render();
      return;
    }

    if (message.type === 'take-command-rejected') {
      const reasons = {
        'participant-required': 'Take needs a Relay participant identity.',
        'mix-not-active': 'There is no room mix to record yet.',
        'product-blocked': 'Fix the room audio before recording a Take.',
        'take-not-ready': 'Start the mic before recording a voice-only Take.',
        'timing-calibration-active': 'Timing calibration is still measuring the room. Wait for it to finish before recording.',
        'take-active': 'A Take is already recording or finishing.',
        'take-not-recording': 'There is no Take recording right now.',
        'stale-take': 'That Stop belonged to an older Take.',
        'invalid-take-id': 'Relay could not identify the Take to stop.',
        'writer-failed': 'Relay could not start the Take recorder.',
        'storage-unavailable': 'Recording storage is not available right now.',
      };
      commandError = reasons[message.reason] ?? `Take was rejected: ${message.reason ?? 'unknown'}`;
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

  sendParticipantAuthentication(next);
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
