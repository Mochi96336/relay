const armButton = document.querySelector('#arm-source');
const stateNode = document.querySelector('#source-state');
const detailNode = document.querySelector('#source-detail');
const mirrorState = document.querySelector('#mirror-state');
const mirrorTimeline = document.querySelector('#mirror-timeline');
const captureState = document.querySelector('#capture-state');
const sourceVolume = document.querySelector('#source-volume');
const sourceVolumeValue = document.querySelector('#source-volume-value');
const sourceMicGain = document.querySelector('#source-mic-gain');
const sourceMicGainValue = document.querySelector('#source-mic-gain-value');
const timingButton = document.querySelector('#start-timing-calibration');
const timingStatus = document.querySelector('#timing-calibration-status');
const gainAdvice = document.querySelector('#gain-advice');
const vocalFineTune = document.querySelector('#vocal-fine-tune');
const vocalFineTuneValue = document.querySelector('#vocal-fine-tune-value');

const STATE_NAMES = new Map([
  [-1, 'waiting'],
  [0, 'ended'],
  [1, 'playing'],
  [2, 'paused'],
  [3, 'buffering'],
  [5, 'cued'],
]);

const ERROR_NAMES = new Map([
  [2, 'invalid video ID'],
  [5, 'HTML5 playback error'],
  [100, 'video unavailable'],
  [101, 'embedding disabled by owner'],
  [150, 'embedding disabled by owner'],
  [153, 'missing Referer / client identity'],
]);

const SLIDER_HOLD_MS = 2000;
const ROBOT_DELTA_SETTLE_MS = 1000;

// The robot has no Chrome extension: `scripts/robot-source.sh` routes Chromium
// through a PipeWire sink into backing:stdin. Advice that names the extension
// is wrong there, and this page is the same page in both deployments.
const ROBOT_MODE = new URLSearchParams(location.search).get('robot') === '1';

let socket = null;
let reconnectTimer = null;
let player = null;
let playerReady = false;
let armed = false;
let latestTimeline = null;
let latestSourceStatus = null;
let latestCalibration = null;
let latestMixHealth = null;
let loadedVideoId = null;
let lastSeekAt = 0;
let playerError = null;
let vocalFineTuneTouchedAt = 0;
let robotSuperseded = false;
let robotDeltaSuppressedUntil = 0;
const sliderTouchedAt = new Map();

// The server echoes every source-status back to every client, which used to
// snap this slider back to a stale value while the user was still dragging it.
function fineTuneIsBusy() {
  return document.activeElement === vocalFineTune
    || performance.now() - vocalFineTuneTouchedAt < SLIDER_HOLD_MS;
}

function sliderIsBusy(slider) {
  return document.activeElement === slider
    || performance.now() - (sliderTouchedAt.get(slider) ?? -Infinity) < SLIDER_HOLD_MS;
}

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

function signed(value, suffix = '') {
  const number = Math.round(Number(value) || 0);
  return `${number > 0 ? '+' : ''}${number}${suffix}`;
}

function send(payload) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(payload));
  return true;
}

/**
 * Turns the live microphone meter into the gain to set.
 *
 * Reads the running mix health rather than the calibration: calibration asks
 * the singer to stay quiet, so the level it measures is the room, not the
 * voice. Peak is what matters here because peak is what hits the limiter.
 */
function renderGainAdvice() {
  if (!gainAdvice) return;
  const rawPeak = latestMixHealth?.micPeakDbfs;
  const rawRecommended = latestMixHealth?.recommendedMicGainDb;
  const peak = rawPeak === null || rawPeak === undefined ? Number.NaN : Number(rawPeak);
  const recommended = rawRecommended === null || rawRecommended === undefined
    ? Number.NaN
    : Number(rawRecommended);

  if (!Number.isFinite(peak) || !Number.isFinite(recommended)) {
    gainAdvice.textContent = '連上手機麥克風後，這裡會即時顯示實際電平與建議的 Mic gain。';
    return;
  }

  const current = Math.round(Number(sourceMicGain.value) || 0);
  const off = recommended - current;
  const verdict = Math.abs(off) <= 3
    ? '目前設定合適'
    : off < 0
      ? `目前 +${current} dB 偏高 ${-off} dB，動態會被壓平`
      : `目前 +${current} dB 偏低 ${off} dB，人聲會太小`;

  gainAdvice.textContent = `麥克風峰值 ${peak.toFixed(1)} dBFS · 建議 Mic gain +${recommended} dB · ${verdict}`;
}

/**
 * The mixer clamps the read-ahead to what the prebuffer affords. When it has
 * to, the vocal sits late by the difference, and nothing else would say so.
 */
function clampNote() {
  const requested = Number(latestSourceStatus?.requestedMicAdvanceMs);
  const applied = Number(latestSourceStatus?.appliedMicAdvanceMs);
  if (!Number.isFinite(requested) || !Number.isFinite(applied)) return '';
  const shortfall = Math.round(requested - applied);
  if (Math.abs(shortfall) < 5) return '';
  return ` · ⚠ 緩衝不足 ${Math.abs(shortfall)} ms，人聲會偏掉；調高 RELAY_LIVE_PREBUFFER_MS`;
}

function safePlayerTime() {
  if (!playerReady || !player) return Number.NaN;
  try {
    return Number(player.getCurrentTime());
  } catch {
    return Number.NaN;
  }
}

function safePlayerState() {
  if (!playerReady || !player) return Number.NaN;
  try {
    return Number(player.getPlayerState());
  } catch {
    return Number.NaN;
  }
}

function parkSupersededRobot() {
  if (!ROBOT_MODE || robotSuperseded) return;
  robotSuperseded = true;
  armed = false;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  try {
    player?.pauseVideo();
    player?.mute();
  } catch {}
  stateNode.textContent = 'Robot source superseded';
  detailNode.textContent = 'A newer robot source owns playback. This page is parked and will not reconnect.';
  mirrorState.textContent = 'superseded · muted';
  timingButton.disabled = true;
}

function applyBalance(sendToServer = true) {
  const songLevel = Math.max(0, Math.min(100, Number(sourceVolume.value) || 0));
  const micGainDb = Math.max(0, Math.min(36, Number(sourceMicGain.value) || 0));

  sourceVolumeValue.value = `${Math.round(songLevel)}%`;
  sourceMicGainValue.value = `${micGainDb > 0 ? '+' : ''}${Math.round(micGainDb)} dB`;

  // Only this page can act on song level - it owns the player - which is why
  // the value lives on the server and arrives here as a message.
  if (playerReady && player) {
    try {
      player.setVolume(songLevel);
    } catch {}
  }

  if (sendToServer && armed && !robotSuperseded) {
    send({ type: 'set-mix', micGainDb, songLevel });
  }

  // The verdict compares the slider against the measurement, so it has to move
  // with the slider and not just with a fresh calibration.
  renderGainAdvice();
}

function applyFineTune(sendToServer = true) {
  const valueMs = Math.max(-100, Math.min(100, Number(vocalFineTune.value) || 0));
  vocalFineTuneValue.value = signed(valueMs, ' ms');
  if (sendToServer) send({ type: 'set-vocal-fine-tune', valueMs });
}

// Must match src/calibration-probe.ts, which builds the reference the server
// correlates against, and public/app.js, which plays the microphone leg.
const PROBE_NOTES = [
  { offsetMs: 0, frequencyHz: 1046.5, gain: 0.24 },
  { offsetMs: 125, frequencyHz: 1318.5, gain: 0.27 },
  { offsetMs: 330, frequencyHz: 1568, gain: 0.32 },
];
const PROBE_NOTE_SECONDS = 0.105;

let probeAudioContext = null;

/**
 * Plays the probe into this page's normal audio output.
 *
 * On the robot that output is `PULSE_SINK=relay_browser`, the same null sink
 * the mirrored YouTube plays into, so the probe reaches the server through
 * PipeWire and `backing:stdin` by exactly the route the song does - which is
 * the whole point: what it measures is that route's delay.
 *
 * Nothing here is audible to anyone. The sink has no speaker behind it.
 */
async function playBackingProbe(requestId, leadMs) {
  if (robotSuperseded) return;
  try {
    if (!probeAudioContext) probeAudioContext = new AudioContext({ latencyHint: 'interactive' });
    if (probeAudioContext.state === 'suspended') await probeAudioContext.resume();

    const startTime = probeAudioContext.currentTime + leadMs / 1000;
    for (const note of PROBE_NOTES) {
      const at = startTime + note.offsetMs / 1000;
      const oscillator = probeAudioContext.createOscillator();
      const gain = probeAudioContext.createGain();
      oscillator.frequency.value = note.frequencyHz;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(note.gain, at + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + PROBE_NOTE_SECONDS);
      oscillator.connect(gain).connect(probeAudioContext.destination);
      oscillator.start(at);
      oscillator.stop(at + PROBE_NOTE_SECONDS);
    }

    // No generation: the capture this lands in belongs to `backing:stdin`,
    // not to this page, so the server checks its own view rather than taking
    // a number this page would only be guessing at.
    send({ type: 'calibration-probe-played', target: 'backing', requestId });
  } catch (error) {
    console.warn('backing probe failed', error);
  }
}

function renderCalibration() {
  const sourceConnected = Boolean(latestSourceStatus?.connected);
  const micConnected = Boolean(latestSourceStatus?.micConnected);
  const phonePlaying = Boolean(latestTimeline?.connected) && Number(latestTimeline?.state) === 1;
  const collecting = latestCalibration?.state === 'collecting';
  timingButton.disabled = robotSuperseded || collecting || !sourceConnected || !micConnected || !phonePlaying;

  if (robotSuperseded) {
    timingStatus.textContent = '這個 Robot Source 已被較新的頁面取代；不再參與播放或校正。';
    return;
  }

  if (collecting) {
    const progress = Math.round((Number(latestCalibration.progress) || 0) * 100);
    timingButton.textContent = `Calibrating… ${progress}%`;
    const need = Number(latestCalibration.windowsNeeded) || 1;
    const rounds = need > 1
      ? ` · 已一致 ${Number(latestCalibration.windowsAgreed) || 0}/${need} 次`
      : '';
    const provisionalNote = latestCalibration.provisional
      ? ` · 已套用暫定值 ${signed(latestCalibration.micLagMs, ' ms')}，持續確認中`
      : '';
    timingStatus.textContent = latestCalibration.automatic
      ? `自動校正中 ${progress}%${rounds}${provisionalNote} · 手機保持喇叭播放，這段先不要唱。`
      : `Collecting ${progress}%${rounds}${provisionalNote} · 手機保持喇叭播放，先不要說話。`;
    return;
  }

  timingButton.textContent = 'Calibrate timing';

  if (latestCalibration?.state === 'complete') {
    const confidence = Number(latestCalibration.confidence);
    const windows = Array.isArray(latestCalibration.segmentLagsMs)
      ? latestCalibration.segmentLagsMs.map((value) => `${signed(value)} ms`).join(' / ')
      : '';
    const stale = latestCalibration.calibrationStale
      ? ' · ⚠ 已過期，建議重跑'
      : '';
    timingStatus.textContent = `✓ Mic path ${signed(latestCalibration.micLagMs, ' ms')} · confidence ${Number.isFinite(confidence) ? confidence.toFixed(2) : '--'}${windows ? ` · windows ${windows}` : ''}${stale}`;
    return;
  }

  if (latestCalibration?.state === 'failed') {
    timingStatus.textContent = latestCalibration.automatic
      ? `自動校正等待可用音訊中 · 上次未成功：${latestCalibration.error ?? '訊號不足'}`
      : `Calibration failed · ${latestCalibration.error ?? 'signal not usable'}。`;
    return;
  }

  if (latestSourceStatus?.timingMode === 'acoustic-calibration') {
    const stale = latestSourceStatus.calibrationStale
      ? ' · ⚠ 設定已改變（麥克風重連 / 播放器 seek），校準值過期，建議重跑'
      : '';
    timingStatus.textContent = `Applied acoustic calibration · Mic path ${signed(latestSourceStatus.calibratedMicLagMs, ' ms')} · fine tune ${signed(latestSourceStatus.vocalFineTuneMs, ' ms')}${stale}${clampNote()}`;
    return;
  }

  if (!sourceConnected || !micConnected) {
    timingStatus.textContent = '先連上手機 Microphone 與 Chrome Source。';
  } else if (!phonePlaying) {
    timingStatus.textContent = latestCalibration?.autoCalibrate
      ? '手機開始播放後會自動校正，不需要有人在這台電腦前面。'
      : '手機播放 YouTube 後即可按 Calibrate timing。';
  } else {
    const estimate = signed(latestSourceStatus?.micNetworkCompensationMs, ' ms');
    timingStatus.textContent = latestCalibration?.autoCalibrate
      ? `即將自動校正 · 目前先用 network estimate ${estimate}。`
      : `Ready · 目前先用 network estimate ${estimate}。`;
  }
}

function renderTimeline() {
  const timeline = latestTimeline;
  const connected = Boolean(timeline?.connected);
  const videoId = typeof timeline?.videoId === 'string' ? timeline.videoId : null;
  const target = Number(timeline?.serverTime);
  const state = Number(timeline?.state);
  const playerState = safePlayerState();
  const current = safePlayerTime();
  const deltaMs = Number.isFinite(current) && Number.isFinite(target)
    ? (current - target) * 1000
    : Number.NaN;

  armButton.disabled = robotSuperseded || armed || !playerReady || !connected || !videoId;

  if (robotSuperseded) {
    stateNode.textContent = 'Robot source superseded';
    detailNode.textContent = 'A newer robot source owns playback.';
    mirrorState.textContent = 'superseded · muted';
    mirrorTimeline.textContent = '--:-- · Δ ignored';
    renderCalibration();
    return;
  }

  if (!connected || !videoId) {
    stateNode.textContent = 'Waiting for phone timeline';
    detailNode.textContent = '手機開始播放 YouTube 後，這裡會自動找到同一支影片。';
    mirrorState.textContent = 'waiting';
    mirrorTimeline.textContent = '--:-- · Δ -- ms';
    renderCalibration();
    return;
  }

  stateNode.textContent = playerError === null
    ? (armed ? 'Source armed' : 'Timeline ready')
    : `YouTube source error ${playerError}`;
  detailNode.textContent = `${videoId} · phone ${STATE_NAMES.get(state) ?? state} · target ${formatTime(target)}`;
  const actualState = playerError === null
    ? Number.isFinite(playerState)
      ? (STATE_NAMES.get(playerState) ?? playerState)
      : 'waiting'
    : `error ${playerError} · ${ERROR_NAMES.get(playerError) ?? 'player failure'}`;
  mirrorState.textContent = `${actualState}${armed ? ' · following' : ' · muted until enabled'}`;
  mirrorTimeline.textContent = `${formatTime(current)} / target ${formatTime(target)} · Δ ${Number.isFinite(deltaMs) ? `${Math.round(deltaMs)} ms` : '-- ms'}`;
  renderCalibration();
}

function applyTimeline() {
  const timeline = latestTimeline;
  if (robotSuperseded) {
    try {
      if (player?.getPlayerState() === 1) player.pauseVideo();
      player?.mute();
    } catch {}
    renderTimeline();
    return;
  }
  if (!playerReady || !player || !timeline?.connected || !timeline.videoId) {
    renderTimeline();
    return;
  }

  const target = Number(timeline.serverTime);
  const desiredState = Number(timeline.state);
  if (!Number.isFinite(target)) return;

  try {
    if (loadedVideoId !== timeline.videoId) {
      playerError = null;
      player.cueVideoById({ videoId: timeline.videoId, startSeconds: Math.max(0, target) });
      loadedVideoId = timeline.videoId;
      lastSeekAt = performance.now();
      robotDeltaSuppressedUntil = lastSeekAt + ROBOT_DELTA_SETTLE_MS;
      send({ type: 'source-seeked' });
      renderTimeline();
      return;
    }

    const current = safePlayerTime();
    const errorSeconds = Number.isFinite(current) ? current - target : Number.NaN;
    const now = performance.now();
    const playerState = safePlayerState();
    const shouldSeek = Number.isFinite(errorSeconds)
      && Math.abs(errorSeconds) > 0.45
      && now - lastSeekAt > 700;

    // A seek is a discontinuity, not a measurement. Do not publish the offset
    // from the same snapshot that triggers seekTo(), and do not publish the
    // IFrame's transient currentTime while it is buffering/settling afterwards.
    if (shouldSeek) {
      player.seekTo(Math.max(0, target), true);
      lastSeekAt = now;
      robotDeltaSuppressedUntil = now + ROBOT_DELTA_SETTLE_MS;
      send({ type: 'source-seeked' });
    } else if (
      ROBOT_MODE
      && armed
      && desiredState === 1
      && playerState === 1
      && now >= robotDeltaSuppressedUntil
      && Number.isFinite(errorSeconds)
    ) {
      send({ type: 'robot-player-offset', offsetMs: errorSeconds * 1000 });
    }

    if (!armed) {
      if (player.getPlayerState() === 1) player.pauseVideo();
      renderTimeline();
      return;
    }

    if (desiredState === 1) {
      if (player.getPlayerState() !== 1) player.playVideo();
    } else if (player.getPlayerState() === 1 || player.getPlayerState() === 3) {
      player.pauseVideo();
    }
  } catch (error) {
    console.warn('Could not apply source timeline', error);
  }

  renderTimeline();
}

function renderSourceStatus(message) {
  latestSourceStatus = message;
  const micState = message.micConnected ? 'Mic connected' : 'Mic disconnected';
  const timing = message.timingMode === 'acoustic-calibration'
    ? `calibrated ${signed(message.calibratedMicLagMs, ' ms')}`
    : `network ${signed(message.micNetworkCompensationMs, ' ms')}`;

  captureState.textContent = !message.connected
    ? 'Capture not connected · click the Relay extension icon on this tab.'
    : message.backingStreaming === false
      ? `⚠ 擷取來源已連線，但沒有音訊送進來${ROBOT_MODE ? ' · 檢查 backing bridge 與 PipeWire 路由。' : ' · 這個分頁重整過的話，請再點一次 Relay 擴充功能圖示。'}`
      : `● Capture connected · ${message.sampleRate ?? '--'} Hz · ${micState} · buffer ${message.prebufferMs ?? '--'} ms · timing ${timing}`;
  renderMixHealth();

  if (Number.isFinite(Number(message.vocalFineTuneMs)) && !fineTuneIsBusy()) {
    vocalFineTune.value = String(Number(message.vocalFineTuneMs));
    applyFineTune(false);
  }
  renderCalibration();
}

function renderMixHealth() {
  if (!latestMixHealth?.active || !captureState.textContent.startsWith('●')) return;

  const notes = [];
  if (latestMixHealth.unheadered) {
    notes.push('⚠ 有 client 還在送沒有 header 的 PCM，請重新載入該頁 / 擴充功能');
  }
  if (latestMixHealth.micStarvedFrames > 0) {
    notes.push(`⚠ 人聲緩衝不足 ${latestMixHealth.micStarvedFrames} frames`);
  }
  if (latestMixHealth.micGapMs > 0) {
    notes.push(`⚠ 人聲缺口 ${latestMixHealth.micGapMs} ms`);
  }
  if (latestMixHealth.backingGapMs > 0) {
    notes.push(`⚠ 歌曲缺口 ${latestMixHealth.backingGapMs} ms`);
  }
  if (latestMixHealth.monitorDroppedFrames > 0) {
    notes.push(`⚠ 丟棄 ${latestMixHealth.monitorDroppedFrames} frames`);
  }
  notes.push(`headroom mic ${latestMixHealth.micHeadroomMs} ms / song ${latestMixHealth.backingHeadroomMs} ms`);
  captureState.textContent += ` · ${notes.join(' · ')}`;
}

function connect() {
  if (robotSuperseded) return;
  clearTimeout(reconnectTimer);
  const next = new WebSocket(wsUrl());
  socket = next;

  next.addEventListener('open', () => {
    if (socket !== next || robotSuperseded) {
      next.close();
      return;
    }
    if (ROBOT_MODE) send({ type: 'robot-source-hello' });
    send({ type: 'youtube-timeline-request' });
    send({ type: 'source-status-request' });
    send({ type: 'timing-calibration-status-request' });
    if (armed) applyBalance();
  });

  next.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return;

    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    if (message.type === 'robot-source-replaced') {
      if (ROBOT_MODE) {
        parkSupersededRobot();
        if (socket === next) socket = null;
        next.close();
        renderTimeline();
      }
      return;
    }

    if (message.type === 'youtube-timeline-status') {
      latestTimeline = message;
      // `serverTime` is already projected to the instant the server emitted
      // this snapshot. Re-applying the same snapshot on a local timer used to
      // make its age look like player drift, feeding a false +0..250 ms sawtooth
      // into boot calibration's delta. Apply only on fresh snapshots instead;
      // the server already emits them every 250 ms while telemetry is live.
      applyTimeline();
      return;
    }

    if (message.type === 'mix-settings') {
      if (!sliderIsBusy(sourceMicGain) && Number.isFinite(Number(message.micGainDb))) {
        sourceMicGain.value = String(message.micGainDb);
      }
      if (!sliderIsBusy(sourceVolume) && Number.isFinite(Number(message.songLevel))) {
        sourceVolume.value = String(message.songLevel);
      }
      applyBalance(false);
      return;
    }

    if (message.type === 'source-status') {
      renderSourceStatus(message);
      return;
    }

    if (message.type === 'timing-calibration-status') {
      latestCalibration = message;
      renderCalibration();
      return;
    }

    if (message.type === 'play-calibration-probe') {
      if (ROBOT_MODE && !robotSuperseded && message.target === 'backing') {
        playBackingProbe(message.requestId, Number(message.leadMs) || 200);
      }
      return;
    }

    if (message.type === 'mix-health') {
      latestMixHealth = message;
      renderGainAdvice();
      if (latestSourceStatus) renderSourceStatus(latestSourceStatus);
      return;
    }

    if (message.type === 'error') {
      timingStatus.textContent = message.message ?? 'Relay error.';
    }
  });

  next.addEventListener('close', () => {
    if (socket !== next) return;
    socket = null;
    latestTimeline = null;
    latestSourceStatus = null;
    renderTimeline();
    if (!robotSuperseded) reconnectTimer = setTimeout(connect, 1_000);
  });

  next.addEventListener('error', () => next.close());
}

armButton.addEventListener('click', () => {
  if (robotSuperseded) return;
  armed = true;
  armButton.disabled = true;
  try {
    player?.unMute();
  } catch {}
  applyBalance();
  applyTimeline();
});

for (const slider of [sourceVolume, sourceMicGain]) {
  slider.addEventListener('input', () => {
    sliderTouchedAt.set(slider, performance.now());
    applyBalance();
  });
}
vocalFineTune.addEventListener('input', () => {
  vocalFineTuneTouchedAt = performance.now();
  applyFineTune(true);
});
vocalFineTune.addEventListener('change', () => {
  vocalFineTuneTouchedAt = performance.now();
});
timingButton.addEventListener('click', () => {
  if (!send({ type: 'start-timing-calibration' })) {
    timingStatus.textContent = 'Server 尚未連線。';
  }
});

window.onYouTubeIframeAPIReady = () => {
  player = new window.YT.Player('source-player', {
    height: '360',
    width: '640',
    playerVars: {
      playsinline: 1,
      controls: 1,
      origin: location.origin,
    },
    events: {
      onReady: () => {
        playerReady = true;
        if (robotSuperseded) {
          try {
            player.mute();
            player.pauseVideo();
          } catch {}
        }
        renderTimeline();
        applyBalance();
        applyTimeline();
      },
      onStateChange: (event) => {
        if (Number(event.data) !== -1) playerError = null;
        renderTimeline();
      },
      onError: (event) => {
        playerError = Number(event.data);
        renderTimeline();
      },
    },
  });
};

const apiScript = document.createElement('script');
apiScript.src = 'https://www.youtube.com/iframe_api';
document.head.append(apiScript);

applyBalance();
applyFineTune(false);
renderTimeline();
connect();
