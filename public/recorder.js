import './take-history.js';
import { authorityState } from './authority-freshness.js';
import { sendParticipantAuthentication } from './participant-auth.js';
await window.relayIdentityReady;
const recordButton = document.querySelector('#start-recording');
const stopButton = document.querySelector('#stop-recording');

const RECONNECT_MS = 1_000;
const START_POLICY_BLOCK_REASONS = new Set([
  'mix-not-active',
  'timing-calibration-active',
  'mic-required',
  'mic-starting',
  'mic-reconnecting',
  'mic-audio-stalled',
  'room-blocked',
  'take-active',
]);

let socket = null;
let reconnectTimer = null;
let latestStatus = { lifecycle: 'idle', take: null, history: [] };
let latestProductStatus = null;
let takeStatusObservedAt = null;
let commandError = null;
let productCanStartTake = false;
let productStatusFresh = false;
let takeStatusFresh = false;
let startCommandPending = false;
let startTakeBlockedReason = null;
let startTakeBlockingIssue = null;

function wsUrl() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const source = new URLSearchParams(location.search);
  const params = new URLSearchParams();
  const key = source.get('key');
  if (key) params.set('key', key);
  const query = params.toString();
  return `${protocol}//${location.host}/ws${query ? `?${query}` : ''}`;
}

function publishTakeStatus(status) {
  window.relayTakeStatus = status;
  window.dispatchEvent(new CustomEvent('relay-take-status', { detail: status }));
}

function recordingState() {
  const lifecycle = String(latestStatus?.lifecycle ?? 'idle');
  const take = latestStatus?.take ?? null;
  const commandChannelFresh = socket?.readyState === WebSocket.OPEN;
  const authorityFresh = productStatusFresh && takeStatusFresh;
  const lastKnownSnapshot = {
    productStatus: latestProductStatus,
    takeStatus: latestStatus,
    takeStatusObservedAt,
  };
  const baseAuthority = authorityState({
    authorityFresh,
    lastKnownSnapshot,
    commandChannelFresh,
    authorized: true,
    serverAllowed: true,
  });
  const startAllowedByServer = productCanStartTake
    && lifecycle !== 'recording'
    && lifecycle !== 'finalizing';
  const startAuthority = authorityState({
    authorityFresh,
    lastKnownSnapshot,
    commandChannelFresh,
    authorized: true,
    serverAllowed: startAllowedByServer && !startCommandPending,
  });
  const stopAuthority = authorityState({
    authorityFresh: takeStatusFresh,
    lastKnownSnapshot: latestStatus,
    commandChannelFresh,
    authorized: true,
    serverAllowed: lifecycle === 'recording' && Boolean(take?.takeId),
  });
  const startBlockedReason = startCommandPending
    ? null
    : startAuthority.actionable
      ? null
      : !baseAuthority.commandChannelFresh || !baseAuthority.authorityFresh
        ? 'reconnecting'
        : startTakeBlockedReason;

  return {
    lifecycle,
    take,
    connected: commandChannelFresh,
    authorityFresh: baseAuthority.authorityFresh,
    lastKnownSnapshot: baseAuthority.lastKnownSnapshot,
    commandChannelFresh: baseAuthority.commandChannelFresh,
    productCanStartTake,
    productStatusFresh,
    takeStatusFresh,
    canStart: startAuthority.actionable,
    startPending: startCommandPending,
    startBlockedReason,
    startBlockingIssue: startBlockedReason === 'room-blocked'
      ? startTakeBlockingIssue
      : null,
    canStop: stopAuthority.actionable,
    commandError,
    snapshotObservedAt: takeStatusObservedAt,
    observedAt: Date.now(),
  };
}

// Recorder owns command/state truth only. recording-ui.js is the sole writer of
// visible recording controls and copy.
function publishRecordingState() {
  const detail = recordingState();
  window.relayRecordingState = detail;
  window.dispatchEvent(new CustomEvent('relay-recording-state', { detail }));
}

window.addEventListener('relay-request-recording-state', publishRecordingState);

function acceptProductStatus(status) {
  if (!status || status.type !== 'product-status') return;
  latestProductStatus = status;
  productCanStartTake = status.actions?.canStartTake === true;
  startTakeBlockedReason = typeof status.actions?.startTakeBlockedReason === 'string'
    ? status.actions.startTakeBlockedReason
    : null;
  startTakeBlockingIssue = startTakeBlockedReason === 'room-blocked'
    && status.actions?.startTakeBlockingIssue
    && typeof status.actions.startTakeBlockingIssue === 'object'
    ? status.actions.startTakeBlockingIssue
    : null;
  // A policy rejection is only an authoritative bridge across the race between
  // the click and the next ProductStatus. Once a fresh ProductStatus arrives,
  // that snapshot owns current readiness again. Infrastructure failures such as
  // storage-unavailable remain visible until their own lifecycle clears them.
  if (
    commandError?.command === 'start'
    && START_POLICY_BLOCK_REASONS.has(commandError.reason)
  ) {
    commandError = null;
  }
  productStatusFresh = true;
  publishRecordingState();
}

function send(payload) {
  if (socket?.readyState !== WebSocket.OPEN) {
    commandError = { command: payload?.type === 'stop-take' ? 'stop' : 'start', reason: 'reconnecting' };
    publishRecordingState();
    return false;
  }
  commandError = null;
  socket.send(JSON.stringify(payload));
  publishRecordingState();
  return true;
}

function clearReconnect() {
  if (!reconnectTimer) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function resetSocketAuthority() {
  productStatusFresh = false;
  takeStatusFresh = false;
  startCommandPending = false;
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
  resetSocketAuthority();
  const next = new WebSocket(url);
  socket = next;
  publishRecordingState();

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
    resetSocketAuthority();
    try { next.close(); } catch {}
    publishRecordingState();
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

    // ProductStatus is the only authority for Record readiness. Requesting and
    // consuming it on recorder's own socket makes readiness replayable: a late
    // recorder module cannot miss the one transition that made canStartTake
    // true and then wait for an unrelated future ProductStatus change.
    if (message.type === 'product-status') {
      acceptProductStatus(message);
      return;
    }

    if (message.type === 'take-status') {
      latestStatus = message;
      takeStatusObservedAt = Date.now();
      takeStatusFresh = true;
      if (
        message.lifecycle === 'recording'
        || message.lifecycle === 'finalizing'
        || message.lifecycle === 'failed'
      ) {
        startCommandPending = false;
      }
      commandError = null;
      publishTakeStatus(message);
      publishRecordingState();
      return;
    }

    if (message.type === 'take-command-rejected') {
      if (message.command === 'start') startCommandPending = false;
      commandError = {
        command: message.command === 'stop' ? 'stop' : 'start',
        reason: typeof message.reason === 'string' ? message.reason : 'unknown',
      };
      publishRecordingState();
    }
  });

  next.addEventListener('close', () => {
    if (socket !== next) return;
    socket = null;
    resetSocketAuthority();
    publishRecordingState();
    scheduleReconnect();
  });
  next.addEventListener('error', () => {
    try { next.close(); } catch {}
  });

  sendParticipantAuthentication(next);
  next.send(JSON.stringify({ type: 'take-status-request' }));
  next.send(JSON.stringify({ type: 'product-status-request' }));
  publishRecordingState();
}

// ProductStatus readiness intentionally has one source: recorder's own socket.
// live-status.js projects the same server snapshots through a separate socket,
// but those snapshots carry no revision. Consuming both channels here would let
// a delayed shared projection overwrite a newer recorder snapshot. The direct
// request above provides replay without introducing that cross-socket race.

recordButton?.addEventListener('click', () => {
  if (startCommandPending || !recordingState().canStart) return;
  startCommandPending = true;
  if (!send({ type: 'start-take' })) {
    startCommandPending = false;
    publishRecordingState();
  }
});

stopButton?.addEventListener('click', () => {
  const takeId = latestStatus?.take?.takeId;
  if (!recordingState().canStop || !takeId) return;
  send({ type: 'stop-take', takeId });
});

setInterval(() => {
  if (latestStatus?.lifecycle === 'recording' && takeStatusFresh) publishRecordingState();
}, 1_000);

publishRecordingState();
connect().catch(scheduleReconnect);
