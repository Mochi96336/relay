import { sendParticipantAuthentication } from './participant-auth.js';
await window.relayIdentityReady;
import { resolvePlaybackRole } from './song-role.js';
import { createPlaybackHandoffReconnectRecovery } from './playback-handoff-reconnect-recovery.js';

let socket = null;
let reconnectTimer = null;
let rttTimer = null;
let pingSequence = 0;
let pendingMicIntentAt = -Infinity;
let roomCommandRevision = 0;
let roomCommandServerIncarnation = null;
let roomCommandRevisionReady = false;
let latestRoomCommandId = null;
let latestRoomSongStatus = null;
let latestTimelineStatus = null;
let activeHandoffId = null;
let activeHandoffPhase = 'idle';
const pendingPings = new Map();
// A plain running minimum never rose again, so one lucky early sample pinned the
// estimate low for the rest of the session even after the link degraded. Keep a
// window of recent samples and take the minimum of those instead.
const RTT_WINDOW = 8;
const recentRttMs = [];

const PLAYBACK_TRANSPORT_KEY = 'relay.playbackTransportId.v1';
const PLAYBACK_GENERATION_KEY = 'relay.playbackGeneration.v1';
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

function nextPlaybackGeneration() {
  const previous = Number(sessionStorage.getItem(PLAYBACK_GENERATION_KEY));
  const wallClock = Date.now();

  // Generation is only ordered within one logical tab transport. If a tab ever
  // exhausted the JS safe-integer range, rotate the transport instead of
  // wrapping and making the newest page look older than an earlier incarnation.
  if (Number.isSafeInteger(previous) && previous >= Number.MAX_SAFE_INTEGER) {
    sessionStorage.removeItem(PLAYBACK_TRANSPORT_KEY);
    sessionStorage.setItem(PLAYBACK_GENERATION_KEY, String(wallClock));
    return wallClock;
  }

  // Seed from wall clock so the first page after upgrading from the old uint32
  // scheme is newer than any still-connected legacy incarnation. Afterwards
  // the stored counter is authoritative: clock rollback cannot reverse page
  // ordering, and two reloads in the same millisecond still get distinct IDs.
  const generation = Number.isSafeInteger(previous) && previous >= 0
    ? Math.max(previous + 1, wallClock)
    : wallClock;
  sessionStorage.setItem(PLAYBACK_GENERATION_KEY, String(generation));
  return generation;
}

const playbackGeneration = nextPlaybackGeneration();
const transportId = playbackTransportId();
// Expose the page transport as a debugging/introspection aid. Product authority
// still comes from the server-attached participant identity, never from a
// participant ID claimed inside a telemetry payload.
window.relayPlaybackTransportId = transportId;
window.relayPlaybackGeneration = playbackGeneration;

const playbackIdentity = {
  participantId: typeof window.relayParticipantId === 'string'
    ? window.relayParticipantId.trim()
    : '',
  transportId,
  generation: playbackGeneration,
};

// youtube-sync owns the playback socket, so reconnect recovery belongs here as
// an ordinary adapter rather than a global WebSocket monkey-patch. Recovered
// terminal packets go back through the same parsed-message path as real server
// packets, keeping active handoff state and UI events in one place.
const reconnectRecovery = createPlaybackHandoffReconnectRecovery((message) => {
  handleServerMessage(message);
});

function networkRttMs() {
  return recentRttMs.length > 0 ? Math.min(...recentRttMs) : Number.POSITIVE_INFINITY;
}

function publishPlaybackDiagnostics(kind, message = {}) {
  const detail = {
    kind,
    ...message,
    observedAt: performance.now(),
  };
  window.relayPlaybackDiagnostics = detail;
  window.dispatchEvent(new CustomEvent('relay:playback-diagnostics', { detail }));
}

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

  const query = params.toString();
  return `${protocol}//${location.host}/ws${query ? `?${query}` : ''}`;
}

function optionalNumber(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
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

function adoptRoomCommandStatus(message) {
  const revision = Number(message.revision);
  if (!Number.isSafeInteger(revision) || revision < 0) return;

  const incarnation = typeof message.serverIncarnation === 'string'
    ? message.serverIncarnation
    : null;
  if (incarnation && incarnation !== roomCommandServerIncarnation) {
    roomCommandServerIncarnation = incarnation;
    roomCommandRevision = revision;
    latestRoomCommandId = null;
  } else {
    updateRoomCommandRevision(revision);
  }
  roomCommandRevisionReady = true;
}

function clearLatestRoomCommand(commandId) {
  if (typeof commandId === 'string' && latestRoomCommandId === commandId) {
    latestRoomCommandId = null;
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

function dispatchHandoff(type, message) {
  window.dispatchEvent(new CustomEvent(type, { detail: message }));
}

function dispatchPlaybackView() {
  const participantId = typeof window.relayParticipantId === 'string'
    ? window.relayParticipantId.trim()
    : '';
  const role = resolvePlaybackRole({
    timeline: latestTimelineStatus,
    room: latestRoomSongStatus,
    participantId,
    transportId,
    playbackGeneration,
  });
  if (!role) return;
  window.dispatchEvent(new CustomEvent('relay:playback-view', {
    detail: {
      role,
      room: latestRoomSongStatus,
      timeline: latestTimelineStatus,
      transportId,
      playbackGeneration,
    },
  }));
}

function handleMessage(event) {
  if (typeof event.data !== 'string') return;

  let message;
  try {
    message = JSON.parse(event.data);
  } catch {
    return;
  }
  handleServerMessage(message);
}

function handleServerMessage(message) {
  if (!message || typeof message !== 'object') return;

  if (message.type === 'clock-pong') {
    handleRttPong(message);
    return;
  }

  if (message.type === 'youtube-telemetry-rejected' || message.type === 'room-song-telemetry-rejected') {
    publishPlaybackDiagnostics('telemetry-rejected', message);
    return;
  }

  if (message.type === 'youtube-timeline-status') {
    // Recovery may synchronously reconstruct a terminal packet here. Route it
    // through handleServerMessage before publishing this fresh authoritative
    // view so private handoff state and player events advance together.
    reconnectRecovery.noteTimeline(message, playbackIdentity);
    latestTimelineStatus = message;
    publishPlaybackDiagnostics('timeline', message);
    dispatchPlaybackView();
    return;
  }

  if (message.type === 'room-song-status') {
    latestRoomSongStatus = message;
    dispatchPlaybackView();
    return;
  }

  if (message.type === 'room-song-command-status') {
    adoptRoomCommandStatus(message);
    if (message.pendingCommandId === null) latestRoomCommandId = null;
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
    clearLatestRoomCommand(message.commandId);
    if (message.room && typeof message.room === 'object') {
      latestRoomSongStatus = message.room;
      dispatchPlaybackView();
    }
    dispatchRoomCommand('relay:room-song-command-rejected', withLatestRoom(message));
    return;
  }

  if (message.type === 'room-song-command-apply') {
    updateRoomCommandRevision(message.revision);
    latestRoomCommandId = message.commandId;
    dispatchRoomCommand('relay:room-song-command-apply', message);
    return;
  }

  if (message.type === 'room-song-command-complete') {
    updateRoomCommandRevision(message.revision);
    clearLatestRoomCommand(message.commandId);
    dispatchRoomCommand('relay:room-song-command-complete', message);
    return;
  }

  if (message.type === 'room-song-command-failed-ack') {
    updateRoomCommandRevision(message.revision);
    clearLatestRoomCommand(message.commandId);
    dispatchRoomCommand('relay:room-song-command-failed-ack', withLatestRoom(message));
    return;
  }

  if (message.type === 'song-handoff-prepare') {
    const handoffId = typeof message.handoffId === 'string' ? message.handoffId : null;
    reconnectRecovery.notePrepare(handoffId);
    // playback-hello is replay-safe, so reconnecting the same page can receive
    // the current plan again. Once this page has already accepted commit for
    // that exact handoff, a replayed prepare is stale and must not rewind the
    // visible player back into cue/preparing. A full page reload resets this
    // adapter state and therefore still accepts the replacement-generation plan.
    if (handoffId && activeHandoffId === handoffId && activeHandoffPhase === 'committing') return;
    activeHandoffId = handoffId;
    activeHandoffPhase = 'preparing';
    dispatchHandoff('relay:song-handoff-prepare', message);
    return;
  }

  if (message.type === 'song-handoff-commit') {
    activeHandoffId = typeof message.handoffId === 'string' ? message.handoffId : null;
    activeHandoffPhase = 'committing';
    reconnectRecovery.noteCommit(activeHandoffId);
    dispatchHandoff('relay:song-handoff-commit', message);
    return;
  }

  if (message.type === 'song-handoff-release') {
    dispatchHandoff('relay:song-handoff-release', message);
    return;
  }

  if (message.type === 'song-handoff-complete') {
    reconnectRecovery.noteComplete(message.handoffId);
    if (!message.handoffId || message.handoffId === activeHandoffId) {
      activeHandoffId = null;
      activeHandoffPhase = 'idle';
    }
    dispatchHandoff('relay:song-handoff-complete', message);
    return;
  }

  if (message.type === 'song-handoff-cancelled') {
    reconnectRecovery.noteCancelled();
    activeHandoffId = null;
    activeHandoffPhase = 'idle';
    dispatchHandoff('relay:song-handoff-cancelled', message);
  }
}

function connect() {
  clearTimeout(reconnectTimer);
  const next = new WebSocket(wsUrl());
  socket = next;

  next.addEventListener('open', () => {
    if (socket !== next) return;
    sendParticipantAuthentication(next);
    recentRttMs.length = 0;
    pendingPings.clear();
    roomCommandRevisionReady = false;
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

  next.addEventListener('message', (event) => {
    if (socket !== next) return;
    handleMessage(event);
  });
  next.addEventListener('close', () => {
    if (socket !== next) return;
    reconnectRecovery.noteSocketClosed();
    socket = null;
    roomCommandRevisionReady = false;
    clearInterval(rttTimer);
    publishPlaybackDiagnostics('disconnected');
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
  if (!roomCommandRevisionReady) {
    dispatchRoomCommand('relay:room-song-command-rejected', {
      type: 'room-song-command-rejected',
      commandId,
      reason: 'syncing',
      revision: roomCommandRevision,
      room: latestRoomSongStatus,
    });
    return;
  }

  const supersedesCommandId = latestRoomCommandId;
  const expectedRevision = roomCommandRevision;
  const sent = send({
    type: 'room-song-command',
    commandId,
    expectedRevision,
    supersedesCommandId,
    ...detail,
  });

  if (sent) {
    latestRoomCommandId = commandId;
    dispatchRoomCommand('relay:room-song-command-sent', {
      commandId,
      expectedRevision,
      supersedesCommandId,
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
    if (activeHandoffId === handoffId) activeHandoffPhase = 'preparing';
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
