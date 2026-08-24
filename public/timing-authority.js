const RECONNECT_MS = 1_000;
const REFRESH_MS = 250;

let socket = null;
let reconnectTimer = null;
let refreshTimer = null;

function currentState() {
  const state = window.relayTimingAuthority;
  if (state && typeof state === 'object') return state;
  return { authorityFresh: false, valueMs: null };
}

function publish(authorityFresh, valueMs = null) {
  const state = {
    authorityFresh: authorityFresh === true,
    valueMs: authorityFresh === true && typeof valueMs === 'number' && Number.isFinite(valueMs)
      ? valueMs
      : null,
  };
  const previous = currentState();
  window.relayTimingAuthority = state;
  if (
    previous.authorityFresh === state.authorityFresh
    && previous.valueMs === state.valueMs
  ) return;
  window.dispatchEvent(new CustomEvent('relay-timing-authority', { detail: state }));
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

function stopRefresh() {
  if (refreshTimer !== null) clearInterval(refreshTimer);
  refreshTimer = null;
}

function requestSourceStatus() {
  if (socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: 'source-status-request' }));
}

function startRefresh() {
  if (refreshTimer !== null) return;
  refreshTimer = setInterval(requestSourceStatus, REFRESH_MS);
}

function scheduleReconnect() {
  if (reconnectTimer !== null) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_MS);
}

function acceptSourceStatus(message) {
  if (message?.type !== 'source-status') return;
  const applied = message.appliedMicAdvanceMs;
  const valueMs = message.active === true
    && typeof applied === 'number'
    && Number.isFinite(applied)
    ? applied
    : null;
  publish(true, valueMs);
  if (message.active === true) startRefresh();
  else stopRefresh();
}

function connect() {
  if (typeof WebSocket !== 'function' || typeof location === 'undefined') return;
  if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;

  stopRefresh();
  publish(false, null);

  const next = new WebSocket(wsUrl());
  socket = next;

  next.addEventListener('open', () => {
    if (socket !== next) return;
    requestSourceStatus();
  });

  next.addEventListener('message', (event) => {
    if (socket !== next || typeof event.data !== 'string') return;
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    acceptSourceStatus(message);
  });

  next.addEventListener('close', () => {
    if (socket !== next) return;
    socket = null;
    stopRefresh();
    publish(false, null);
    scheduleReconnect();
  });

  next.addEventListener('error', () => {
    try { next.close(); } catch {}
  });
}

if (!window.relayTimingAuthority) {
  window.relayTimingAuthority = { authorityFresh: false, valueMs: null };
}
connect();
