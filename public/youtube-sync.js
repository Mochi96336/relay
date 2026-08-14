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
let clockTimer = null;
let clockOffsetMs = null;
let bestClockRttMs = Number.POSITIVE_INFINITY;
let clockSequence = 0;
const pendingPings = new Map();

const panel = document.querySelector('.youtube-panel');
const localReadout = panel?.querySelector('.youtube-readout');

const serverReadout = document.createElement('div');
serverReadout.className = 'youtube-readout';
serverReadout.innerHTML = '<strong id="server-timeline-state">Server timeline · connecting…</strong><span id="server-timeline-values">YT -- · Server --</span>';

const serverNote = document.createElement('p');
serverNote.id = 'server-timeline-note';
serverNote.className = 'hint';
serverNote.textContent = 'Clock sync and Server timeline are starting.';

if (localReadout) {
  localReadout.insertAdjacentElement('afterend', serverReadout);
  serverReadout.insertAdjacentElement('afterend', serverNote);
}

const serverState = document.querySelector('#server-timeline-state');
const serverValues = document.querySelector('#server-timeline-values');

function wsUrl() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const key = new URLSearchParams(location.search).get('key');
  const query = key ? `?key=${encodeURIComponent(key)}` : '';
  return `${protocol}//${location.host}/ws${query}`;
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

function sendClockPing() {
  const id = ++clockSequence;
  const clientSentAtMs = Date.now();
  pendingPings.set(id, clientSentAtMs);
  send({ type: 'clock-ping', id, clientSentAtMs });

  if (pendingPings.size > 12) {
    const oldest = pendingPings.keys().next().value;
    pendingPings.delete(oldest);
  }
}

function handleClockPong(message) {
  const id = Number(message.id);
  const clientSentAtMs = pendingPings.get(id);
  if (!Number.isFinite(clientSentAtMs)) return;
  pendingPings.delete(id);

  const clientReceivedAtMs = Date.now();
  const serverReceivedAtMs = Number(message.serverReceivedAtMs);
  const serverSentAtMs = Number(message.serverSentAtMs);
  if (!Number.isFinite(serverReceivedAtMs) || !Number.isFinite(serverSentAtMs)) return;

  const serverProcessingMs = Math.max(0, serverSentAtMs - serverReceivedAtMs);
  const rttMs = Math.max(0, clientReceivedAtMs - clientSentAtMs - serverProcessingMs);
  const offsetMs = ((serverReceivedAtMs - clientSentAtMs) + (serverSentAtMs - clientReceivedAtMs)) / 2;

  if (rttMs <= bestClockRttMs + 2) {
    bestClockRttMs = Math.min(bestClockRttMs, rttMs);
    clockOffsetMs = clockOffsetMs === null ? offsetMs : clockOffsetMs * 0.7 + offsetMs * 0.3;
  }
}

function renderTimeline(message) {
  if (!serverState || !serverValues) return;

  if (!message.videoId) {
    serverState.textContent = 'Server timeline · waiting for YouTube';
    serverValues.textContent = 'YT -- · Server --';
    serverNote.textContent = 'Load and play YouTube on the phone to establish the Server timeline.';
    return;
  }

  const state = STATE_NAMES.get(Number(message.state)) ?? `state ${message.state}`;
  const connected = Boolean(message.connected);
  const differenceMs = optionalNumber(message.differenceMs);
  const drift = optionalNumber(message.driftMsPerMinute);
  const rtt = optionalNumber(message.clockRttMs);
  const age = optionalNumber(message.ageMs);
  const youtubeTime = optionalNumber(message.youtubeTime);
  const serverTime = optionalNumber(message.serverTime);

  serverState.textContent = `Server timeline · ${connected ? state : 'stale'} · ${message.lastReason ?? 'tracking'}`;
  serverValues.textContent = youtubeTime !== null && serverTime !== null
    ? `YT ${youtubeTime.toFixed(3)} s · Server ${serverTime.toFixed(3)} s · Δ ${signed(differenceMs)} ms`
    : 'YT -- · Server --';

  const driftText = drift !== null ? `${signed(drift, 1)} ms/min` : 'collecting';
  const rttText = rtt !== null ? `${rtt.toFixed(0)} ms RTT` : 'clock sync…';
  const ageText = age !== null ? `${age.toFixed(0)} ms old` : 'age --';
  serverNote.textContent = `Drift ${driftText} · ${rttText} · ${ageText} · hard resyncs ${Number(message.hardResyncs) || 0}`;
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
    handleClockPong(message);
    return;
  }

  if (message.type === 'youtube-timeline-status') {
    renderTimeline(message);
  }
}

function connect() {
  clearTimeout(reconnectTimer);
  const next = new WebSocket(wsUrl());
  socket = next;

  next.addEventListener('open', () => {
    if (socket !== next) return;
    clockOffsetMs = null;
    bestClockRttMs = Number.POSITIVE_INFINITY;
    pendingPings.clear();
    send({ type: 'youtube-timeline-request' });
    sendClockPing();
    setTimeout(sendClockPing, 180);
    setTimeout(sendClockPing, 450);
    clearInterval(clockTimer);
    clockTimer = setInterval(sendClockPing, 5_000);
  });

  next.addEventListener('message', handleMessage);
  next.addEventListener('close', () => {
    if (socket !== next) return;
    socket = null;
    clearInterval(clockTimer);
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
    sampledAtServerMs: Number.isFinite(clockOffsetMs)
      ? Number(detail.sampledAtMs) + clockOffsetMs
      : undefined,
    clockRttMs: Number.isFinite(bestClockRttMs) ? bestClockRttMs : undefined,
  });
});

connect();
