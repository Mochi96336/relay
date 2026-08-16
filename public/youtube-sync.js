const STATE_NAMES = new Map([
  [-1, 'unstarted'],
  [0, 'ended'],
  [1, 'playing'],
  [2, 'paused'],
  [3, 'buffering'],
  [5, 'cued'],
]);

let socket = null;
let reconnectTimer = null;
let rttTimer = null;
let pingSequence = 0;
let pendingMicIntentAt = -Infinity;
let roomCommandRevision = 0;
let latestRoomSongStatus = null;
const pendingPings = new Map();
// A plain running minimum never rose again, so one lucky early sample pinned the
// estimate low for the rest of the session even after the link degraded. Keep a
// window of recent samples and take the minimum of those instead.
const RTT_WINDOW = 8;
const recentRttMs = [];

const PLAYBACK_TRANSPORT_KEY = 'relay.playbackTransportId.v1';
const playbackGeneration = Date.now() >>> 0;
const MIC_INTENT_REPLAY_MS = 8_000;

function randomPlaybackTransportId() {
  const random = new Uint32Array(4);
  crypto.getRandomValues(random);
  return `playback-${Array.from(random, (value) => value.toString(16).padStart(8, '0')).join('')}`;
}

function randomRoomCommandId() {
  const random = new Uint32Array(2);
  crypto.getRandomValues(random);
  return `song-${Date.now().toString(36)}-${Array.from(random, (value) => value.toString(16).padStart(8, '0')).join('')}`;
}

function playbackTransportId() {
  let id = sessionStorage.getItem(PLAYBACK_TRANSPORT_KEY);
  if (!id || !/^[A-Za-z0-9_.:-]{8,128}$/.test(id)) {
    id = randomPlaybackTransportId();
    sessionStorage.setItem(PLAYBACK_TRANSPORT_KEY, id);
  }
  return id;
}

const transportId = playbackTransportId();
// Expose the page transport as a debugging/introspection aid. Product authority
// still comes from the server-attached participant identity, never from a
// participant ID claimed inside a telemetry payload.
window.relayPlaybackTransportId = transportId;
window.relayPlaybackGeneration = playbackGeneration;

function networkRttMs() {
  return recentRttMs.length > 0 ? Math.min(...recentRttMs) : Number.POSITIVE_INFINITY;
}

const panel = document.querySelector('.youtube-panel');
const localReadout = panel?.querySelector('.youtube-readout');

const serverReadout = document.createElement('div');
serverReadout.className = 'youtube-readout';
serverReadout.innerHTML = '<strong id="server-timeline-state">Server timeline · connecting…</strong><span id="server-timeline-values">YT -- · Server --</span>';

const serverNote = document.createElement('p');
serverNote.id = 'server-timeline-note';
serverNote.className = 'hint';
serverNote.textContent = 'Server media-clock tracking is starting.';

if (localReadout) {
  localReadout.insertAdjacentElement('afterend', serverReadout);
  serverReadout.insertAdjacentElement('afterend', serverNote);
}

const serverState = document.querySelector('#server-timeline-state');
const serverValues = document.querySelector('#server-timeline-values');

function wsUrl() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const source = new URLSearchParams(location.search);
  const params = new URLSearchParams();
  const key = source.get('key');
  if (key) params.set('key', key);

  // Playback is a human page transport, not robot infrastructure. Carry the
  // same explicit participant identity as the presence/publisher sockets so
  // the server can authorize telemetry without trusting a participant ID in
  // the telemetry payload itself.
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

function optionalNumber(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function signed(value, digits = 0) {
  if (!Number.isFinite(value)) return '--';
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}`;
}

function send(payload) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
    return true;
  }
  return false;
}

function dispatchRoomCommand(type, detail) {
  window.dispatchEvent(new CustomEvent(type, { detail }));
}

function withLatestRoom(message) {
  return {
    ...message,
    room: message.room && typeof message.room === 'object'
      ? message.room
      : latestRoomSongStatus,
  };
}

function updateRoomCommandRevision(value) {
  const revision = Number(value);
  if (Number.isSafeInteger(revision) && revision >= 0) {
    roomCommandRevision = Math.max(roomCommandRevision, revision);
  }
}

function sendPlaybackHello() {
  send({
    type: 'playback-hello',
    playbackTransportId: transportId,
    playbackGeneration,
  });
}

function noteMicIntent() {
  pendingMicIntentAt = performance.now();
  send({ type: 'playback-mic-intent' });
}

function replayRecentMicIntent() {
  if (performance.now() - pendingMicIntentAt <= MIC_INTENT_REPLAY_MS) {
    send({ type: 'playback-mic-intent' });
  }
}

function sendRttPing() {
  const id = ++pingSequence;
  const sentAt = performance.now();
  pendingPings.set(id, sentAt);
  send({ type: 'clock-ping', id });

  if (pendingPings.size > 12) {
    const oldest = pendingPings.keys().next().value;
    pendingPings.delete(oldest);
  }
}

function handleRttPong(message) {
  const id = Number(message.id);
  const sentAt = pendingPings.get(id);
  if (!Number.isFinite(sentAt)) return;
  pendingPings.delete(id);

  const receivedAt = performance.now();
  const explicitProcessing = optionalNumber(message.serverProcessingMs);
  const serverReceivedAt = optionalNumber(message.serverReceivedAtMs);
  const serverSentAt = optionalNumber(message.serverSentAtMs);
  const serverProcessingMs = explicitProcessing ?? (
    serverReceivedAt !== null && serverSentAt !== null
      ? Math.max(0, serverSentAt - serverReceivedAt)
      : 0
  );
  const rttMs = Math.max(0, receivedAt - sentAt - serverProcessingMs);

  recentRttMs.push(rttMs);
  while (recentRttMs.length > RTT_WINDOW) recentRttMs.shift();
}

function renderTimeline(message) {
  if (!serverState || !serverValues) return;

  if (!message.videoId) {
    serverState.textContent = 'Server timeline · waiting for YouTube';
    serverValues.textContent = 'YT -- · Server --';
    serverNote.textContent = 'Load and play YouTube on the phone to establish the Server media timeline.';
    return;
  }

  const state = STATE_NAMES.get(Number(message.state)) ?? `state ${message.state}`;
  const connected = Boolean(message.connected);
  const differenceMs = optionalNumber(message.differenceMs);
  const drift = optionalNumber(message.driftMsPerMinute);
  const jitter = optionalNumber(message.measurementJitterMs);
  const rtt = optionalNumber(message.networkRttMs ?? message.clockRttMs);
  const transport = optionalNumber(message.transportEstimateMs);
  const age = optionalNumber(message.ageMs);
  const youtubeTime = optionalNumber(message.youtubeTime);
  const serverTime = optionalNumber(message.serverTime);
  const reanchors = Number(message.reanchors) || 0;
  const corrections = Number(message.corrections ?? message.hardResyncs) || 0;

  serverState.textContent = `Server timeline · ${connected ? state : 'stale'} · ${message.lastReason ?? 'tracking'}`;
  serverValues.textContent = youtubeTime !== null && serverTime !== null
    ? `YT ${youtubeTime.toFixed(3)} s · Server ${serverTime.toFixed(3)} s · phase Δ ${signed(differenceMs)} ms`
    : 'YT -- · Server --';

  const driftText = drift !== null ? `${signed(drift, 1)} ms/min` : 'collecting';
  const jitterText = jitter !== null ? `${jitter.toFixed(0)} ms jitter` : 'jitter --';
  const rttText = rtt !== null ? `${rtt.toFixed(0)} ms RTT` : 'RTT…';
  const transportText = transport !== null ? `one-way≈${transport.toFixed(0)} ms` : 'one-way --';
  const ageText = age !== null ? `${age.toFixed(0)} ms old` : 'age --';
  serverNote.textContent = `Drift ${driftText} · ${jitterText} · ${rttText} · ${transportText} · ${ageText} · reanchors ${reanchors} · corrections ${corrections}`;
}

function dispatchHandoff(type, message) {
  window.dispatchEvent(new CustomEvent(type, { detail: message }));
}

function handleMessage(event) {
  if (typeof event.data !== 'string') return;

  let message;
  try {
    message = JSON.parse(event.data);
  } catch {
    return;
  }

  if (message.type === 'clock-pong') {
    handleRttPong(message);
    return;
  }

  if (message.type === 'youtube-timeline-status') {
    renderTimeline(message);
    return;
  }

  if (message.type === 'room-song-status') {
    latestRoomSongStatus = message;
    return;
  }

  if (message.type === 'room-song-command-status') {
    updateRoomCommandRevision(message.revision);
    dispatchRoomCommand('relay:room-song-command-status', withLatestRoom(message));
    return;
  }

  if (message.type === 'room-song-command-accepted') {
    updateRoomCommandRevision(message.revision);
    dispatchRoomCommand('relay:room-song-command-accepted', message);
    return;
  }

  if (message.type === 'room-song-command-rejected') {
    updateRoomCommandRevision(message.revision);
    if (message.room && typeof message.room === 'object') latestRoomSongStatus = message.room;
    dispatchRoomCommand('relay:room-song-command-rejected', withLatestRoom(message));
    return;
  }

  if (message.type === 'room-song-command-apply') {
    updateRoomCommandRevision(message.revision);
    dispatchRoomCommand('relay:room-song-command-apply', message);
    return;
  }

  if (message.type === 'room-song-command-complete') {
    updateRoomCommandRevision(message.revision);
    dispatchRoomCommand('relay:room-song-command-complete', message);
    return;
  }

  if (message.type === 'room-song-command-failed-ack') {
    updateRoomCommandRevision(message.revision);
    dispatchRoomCommand('relay:room-song-command-failed-ack', withLatestRoom(message));
    return;
  }

  if (message.type === 'song-handoff-prepare') {
    dispatchHandoff('relay:song-handoff-prepare', message);
    return;
  }

  if (message.type === 'song-handoff-commit') {
    dispatchHandoff('relay:song-handoff-commit', message);
    return;
  }

  if (message.type === 'song-handoff-release') {
    dispatchHandoff('relay:song-handoff-release', message);
    return;
  }

  if (message.type === 'song-handoff-complete') {
    dispatchHandoff('relay:song-handoff-complete', message);
  }
}

function connect() {
  clearTimeout(reconnectTimer);
  const next = new WebSocket(wsUrl());
  socket = next;

  next.addEventListener('open', () => {
    if (socket !== next) return;
    recentRttMs.length = 0;
    pendingPings.clear();
    sendPlaybackHello();
    replayRecentMicIntent();
    send({ type: 'youtube-timeline-request' });
    send({ type: 'room-song-status-request' });
    send({ type: 'room-song-command-status-request' });
    sendRttPing();
    setTimeout(sendRttPing, 180);
    setTimeout(sendRttPing, 450);
    clearInterval(rttTimer);
    rttTimer = setInterval(sendRttPing, 5_000);
  });

  next.addEventListener('message', handleMessage);
  next.addEventListener('close', () => {
    if (socket !== next) return;
    socket = null;
    clearInterval(rttTimer);
    if (serverState) serverState.textContent = 'Server timeline · disconnected';
    reconnectTimer = setTimeout(connect, 1_000);
  });

  next.addEventListener('error', () => {
    next.close();
  });
}

window.addEventListener('relay:youtube-telemetry', (event) => {
  const detail = event.detail;
  if (!detail || typeof detail !== 'object') return;

  send({
    type: 'youtube-telemetry',
    ...detail,
    playbackTransportId: transportId,
    playbackGeneration,
    networkRttMs: Number.isFinite(networkRttMs()) ? networkRttMs() : undefined,
  });
});

window.addEventListener('relay:room-song-command-intent', (event) => {
  const detail = event.detail;
  if (!detail || typeof detail !== 'object' || typeof detail.action !== 'string') return;

  const commandId = randomRoomCommandId();
  const sent = send({
    type: 'room-song-command',
    commandId,
    expectedRevision: roomCommandRevision,
    ...detail,
  });

  if (sent) {
    dispatchRoomCommand('relay:room-song-command-sent', {
      commandId,
      expectedRevision: roomCommandRevision,
      ...detail,
    });
  } else {
    dispatchRoomCommand('relay:room-song-command-rejected', {
      type: 'room-song-command-rejected',
      commandId,
      reason: 'disconnected',
      revision: roomCommandRevision,
      room: latestRoomSongStatus,
    });
  }
});

window.addEventListener('relay:room-song-command-failed', (event) => {
  const commandId = event.detail?.commandId;
  if (typeof commandId === 'string') {
    send({
      type: 'room-song-command-failed',
      commandId,
      reason: event.detail?.reason ?? 'playback-failed',
    });
  }
});

window.addEventListener('relay:song-handoff-ready', (event) => {
  const handoffId = event.detail?.handoffId;
  if (typeof handoffId === 'string') send({ type: 'song-handoff-ready', handoffId });
});

window.addEventListener('relay:song-handoff-failed', (event) => {
  const handoffId = event.detail?.handoffId;
  if (typeof handoffId === 'string') {
    send({ type: 'song-handoff-failed', handoffId, reason: event.detail?.reason ?? 'playback-failed' });
  }
});

// Bind the Mic action to this exact visible playback tab without changing the
// publisher protocol. Presence-driven takeover emits the custom event; the
// ordinary Microphone button is captured directly. Reconnects do not create a
// new intent, so they cannot accidentally move playback between tabs.
document.querySelector('#start-publisher')?.addEventListener('click', noteMicIntent);
window.addEventListener('relay-request-microphone', noteMicIntent);

connect();
