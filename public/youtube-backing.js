const startButton = document.querySelector('#start-youtube-backing');
const stopButton = document.querySelector('#stop-youtube-backing');
const statusNode = document.querySelector('#youtube-backing-status');

const STATE_NAMES = new Map([
  [-1, 'waiting'],
  [0, 'ended'],
  [1, 'playing'],
  [2, 'paused'],
  [3, 'buffering'],
  [5, 'cued'],
]);

let socket = null;
let reconnectTimer = null;
let latest = null;

function wsUrl() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const key = new URLSearchParams(location.search).get('key');
  const query = key ? `?key=${encodeURIComponent(key)}` : '';
  return `${protocol}//${location.host}/ws${query}`;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const remainder = whole % 60;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function send(payload) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
    return true;
  }
  return false;
}

function render(message = latest) {
  latest = message;
  if (!message) {
    startButton.disabled = true;
    stopButton.disabled = true;
    statusNode.textContent = '正在連線到 Server…';
    return;
  }

  const active = Boolean(message.active);
  const available = Boolean(message.available);
  const state = STATE_NAMES.get(Number(message.state)) ?? `state ${message.state}`;
  const position = Number(message.positionSeconds);

  startButton.disabled = active || !available;
  stopButton.disabled = !active;

  if (active) {
    statusNode.textContent = `● Server test backing · ${state} · ${formatTime(position)} · 48 kHz`;
  } else if (available) {
    statusNode.textContent = `Ready · YouTube ${state} · ${formatTime(position)} · 按 Start follower 開始`;
  } else {
    statusNode.textContent = '先在手機 Load 並播放 YouTube，Server timeline 建立後才能開始。';
  }
}

function connect() {
  clearTimeout(reconnectTimer);
  const next = new WebSocket(wsUrl());
  socket = next;

  next.addEventListener('open', () => {
    if (socket !== next) return;
    send({ type: 'youtube-backing-status-request' });
  });

  next.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return;

    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    if (message.type === 'youtube-backing-status') {
      render(message);
      return;
    }

    if (message.type === 'error') {
      statusNode.textContent = message.message ?? 'Server backing error.';
    }
  });

  next.addEventListener('close', () => {
    if (socket !== next) return;
    socket = null;
    latest = null;
    render();
    statusNode.textContent = 'Server backing control disconnected · reconnecting…';
    reconnectTimer = setTimeout(connect, 1_000);
  });

  next.addEventListener('error', () => {
    next.close();
  });
}

startButton.addEventListener('click', () => {
  if (!send({ type: 'start-youtube-backing' })) {
    statusNode.textContent = 'Server 尚未連線。';
  }
});

stopButton.addEventListener('click', () => {
  send({ type: 'stop-youtube-backing' });
});

render();
connect();
