const publisherButton = document.querySelector('#start-publisher');
const monitorButton = document.querySelector('#start-monitor');
const stopButton = document.querySelector('#stop');
const testStartButton = document.querySelector('#start-sync-test');
const testStopButton = document.querySelector('#stop-sync-test');
const status = document.querySelector('#status');
const details = document.querySelector('#details');
const monitorGain = document.querySelector('#monitor-gain');
const monitorGainValue = document.querySelector('#monitor-gain-value');
const micGain = document.querySelector('#mic-gain');
const micGainValue = document.querySelector('#mic-gain-value');
const micGainAdvice = document.querySelector('#mic-gain-advice');
const songLevel = document.querySelector('#song-level');
const songLevelValue = document.querySelector('#song-level-value');
const calibrateButton = document.querySelector('#calibrate-timing');
const calibrateStatus = document.querySelector('#calibrate-status');

const TEST_BPM = 120;
const MIX_SAMPLE_RATE = 48000;
const SOCKET_RECONNECT_MS = 1000;
const SLIDER_HOLD_MS = 2000;
const MONITOR_PREBUFFER_MS = 250;
const MONITOR_MAX_QUEUE_MS = 800;

let socket = null;
let socketReconnectTimer = null;
let audioContext = null;
let mediaStream = null;
let activeNode = null;
let playbackNode = null;
let monitorGainNode = null;
let sourceSampleRate = null;
let activeRole = null;
let testActive = false;
let liveMixActive = false;
let latestMixHealth = null;
let latestCalibration = null;

/**
 * Whether what arrives on this socket is a server mix rather than raw
 * microphone PCM. Two different things put the server into that state - the
 * click test and a live session - and only the first of them is a test. Reading
 * one from the other is what made every live take behave like a test run.
 */
function serverMixActive() {
  return testActive || liveMixActive;
}

/**
 * The same measured advice source.html shows, put where the singer can act on
 * it. Mic gain is one server value with a slider on each page, and the person
 * whose voice decides the right setting is holding the phone - they cannot see
 * the desktop screen while singing.
 */
function renderGainAdvice() {
  if (!micGainAdvice) return;
  const peak = Number(latestMixHealth?.micPeakDbfs);
  const recommended = Number(latestMixHealth?.recommendedMicGainDb);

  if (!Number.isFinite(peak) || !Number.isFinite(recommended)) {
    micGainAdvice.textContent = '開始唱之後，這裡會顯示實際電平與建議的 Mic gain。';
    return;
  }

  const current = Math.round(Number(micGain.value) || 0);
  const off = recommended - current;
  const verdict = Math.abs(off) <= 3
    ? '目前設定合適'
    : off < 0
      ? `偏高 ${-off} dB，動態會被壓平`
      : `偏低 ${off} dB，人聲會太小`;

  micGainAdvice.textContent = `峰值 ${peak.toFixed(1)} dBFS · 建議 +${recommended} dB · ${verdict}`;
}
let clickScheduler = null;
let nextClickTime = 0;
let clickBeat = 0;
let rawMonitorGainDb = 30;
let uplinkDroppedChunks = 0;
let lastUplinkWarningAt = 0;
let monitorHealth = null;
// Seeded from the clock, not 0: a page reload starts a new module scope and
// would otherwise reuse the same first-ever generation number, which the
// server take as "nothing changed" and skip re-anchoring the mic timeline to
// the new capture. Wire format is a Uint32 (see framePcm below); the seconds
// component keeps this unique across any reload that is not the same
// millisecond as a previous one, which a real reload never is.
let captureGeneration = Date.now();
let captureSampleCursor = 0;

// Byte layout is pinned by src/pcm-frame.ts and test/pcm-frame.test.ts. Each
// frame states where it belongs, so a chunk dropped here leaves a hole of the
// right length on the server instead of pulling all later audio earlier.
const FRAME_MAGIC = 0x4c52;
const FRAME_VERSION = 1;
const FRAME_HEADER_BYTES = 16;

function framePcm(pcm, generation, firstSampleIndex) {
  const frame = new ArrayBuffer(FRAME_HEADER_BYTES + pcm.byteLength);
  const view = new DataView(frame);
  view.setUint16(0, FRAME_MAGIC, true);
  view.setUint8(2, FRAME_VERSION);
  view.setUint8(3, 0);
  view.setUint32(4, generation >>> 0, true);
  view.setFloat64(8, firstSampleIndex, true);
  new Uint8Array(frame, FRAME_HEADER_BYTES).set(new Uint8Array(pcm));
  return frame;
}

// recorder.js reads this so it can warn when Solo recording is started on the
// same device that is publishing the microphone.
window.relayActiveRole = null;

function setStatus(title, body = '') {
  status.textContent = title;
  details.textContent = body;
}

function setActiveRole(role) {
  activeRole = role;
  window.relayActiveRole = role;
}

function dbToGain(db) {
  return 10 ** (db / 20);
}

function signed(value, suffix) {
  const number = Number(value);
  return `${number > 0 ? '+' : ''}${number}${suffix}`;
}

// Server broadcasts echo every mix change back to every client. Without this an
// incoming echo rewrites the slider the user is still dragging.
const sliderTouchedAt = new WeakMap();

function markSliderTouched(element) {
  sliderTouchedAt.set(element, performance.now());
}

function sliderIsBusy(element) {
  if (document.activeElement === element) return true;
  const touchedAt = sliderTouchedAt.get(element);
  return touchedAt !== undefined && performance.now() - touchedAt < SLIDER_HOLD_MS;
}

function updateMonitorGain() {
  const db = Number(monitorGain.value);
  monitorGainValue.value = signed(db, ' dB');
  if (!testActive) rawMonitorGainDb = db;
  if (monitorGainNode && audioContext) {
    monitorGainNode.gain.setTargetAtTime(dbToGain(db), audioContext.currentTime, 0.01);
  }
}

function updateMixLabels() {
  micGainValue.value = signed(micGain.value, ' dB');
  songLevelValue.value = `${Math.round(Number(songLevel.value) || 0)}%`;
  // The verdict compares the slider against the meter, so it moves with both.
  renderGainAdvice();
}

function sendMixSettings() {
  updateMixLabels();
  if (socket?.readyState !== WebSocket.OPEN || !activeRole) return;
  socket.send(JSON.stringify({
    type: 'set-mix',
    micGainDb: Number(micGain.value),
    // The song is played by the machine hosting the mirrored player, which in
    // the finished topology is the robot - nobody is at its screen, so the
    // value belongs to the server and the phone drives it from here.
    songLevel: Number(songLevel.value),
  }));
}

function updateTestButtons() {
  testStartButton.disabled = activeRole !== 'publisher' || testActive;
  testStopButton.disabled = !activeRole || !testActive;
  micGain.disabled = !activeRole;
  songLevel.disabled = !activeRole;
  // Same dependency on activeRole, so it rides along rather than needing a
  // call at every site that changes roles.
  updateCalibrateButton();
}

/**
 * Calibration runs itself, but the singer is the one who can hear that it got
 * it wrong, and they are not at the machine the other button is on.
 */
function updateCalibrateButton() {
  const collecting = latestCalibration?.state === 'collecting';
  calibrateButton.disabled = !activeRole || !liveMixActive || collecting;

  if (!liveMixActive) {
    calibrateStatus.textContent = '播放開始後會自動校正；覺得對不上可以在這裡手動重跑。';
    return;
  }

  if (collecting) {
    const progress = Math.round((Number(latestCalibration.progress) || 0) * 100);
    const need = Number(latestCalibration.windowsNeeded) || 1;
    // A window is not fully trusted until agreement confirms it, so say how
    // far the run has got - otherwise repeated windows look like it is stuck.
    // A confident single window may already be applied underneath this (see
    // provisionalNote); that does not end the run, it just means singing does
    // not have to wait on it.
    const rounds = need > 1
      ? ` · 已一致 ${Number(latestCalibration.windowsAgreed) || 0}/${need} 次`
      : '';
    const provisionalNote = latestCalibration.provisional
      ? ` · 已套用暫定值 ${signed(latestCalibration.micLagMs, ' ms')}`
      : '';
    calibrateStatus.textContent = `校正中 ${progress}%${rounds}${provisionalNote} · 這幾秒先不要唱，讓麥克風收到伴奏。`;
    return;
  }

  if (latestCalibration?.state === 'complete') {
    const stale = latestCalibration.calibrationStale ? ' · 設定已改變，建議重跑' : '';
    calibrateStatus.textContent = `已校正 ${signed(latestCalibration.micLagMs, ' ms')}${stale}`;
    return;
  }

  if (latestCalibration?.state === 'failed') {
    calibrateStatus.textContent = latestCalibration.automatic
      ? '等待可用的音訊中，會自動重試。'
      : `校正未成功：${latestCalibration.error ?? '訊號不足'}`;
    return;
  }

  calibrateStatus.textContent = '尚未校正 · 目前用網路估計值。';
}

function wsUrl() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const key = new URLSearchParams(location.search).get('key');
  const query = key ? `?key=${encodeURIComponent(key)}` : '';
  return `${protocol}//${location.host}/ws${query}`;
}

function connectSocket() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl());
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', () => reject(new Error('WebSocket connection failed.')), { once: true });
  });
}

function clearSocketReconnect() {
  if (!socketReconnectTimer) return;
  clearTimeout(socketReconnectTimer);
  socketReconnectTimer = null;
}

function linearResample(input, sourceRate, targetRate) {
  if (sourceRate === targetRate) return input;

  const ratio = targetRate / sourceRate;
  const outputLength = Math.max(1, Math.round(input.length * ratio));
  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i += 1) {
    const sourcePosition = i / ratio;
    const index = Math.floor(sourcePosition);
    const fraction = sourcePosition - index;
    const a = input[Math.min(index, input.length - 1)];
    const b = input[Math.min(index + 1, input.length - 1)];
    output[i] = a + (b - a) * fraction;
  }

  return output;
}

function int16ToFloat32(buffer) {
  const input = new Int16Array(buffer);
  const output = new Float32Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    output[i] = input[i] / (input[i] < 0 ? 0x8000 : 0x7fff);
  }
  return output;
}

// Must match src/calibration-probe.ts, which builds the reference the server
// correlates against. Irregular offsets are the point: no shift other than the
// true one lines all three clicks up at once, which is exactly the ambiguity
// correlating against a song's own beat cannot escape.
const PROBE_CLICK_OFFSETS_MS = [0, 165, 420];
const PROBE_FREQUENCY_HZ = 1800;
const PROBE_CLICK_DECAY_PER_SECOND = 55;
const PROBE_CLICK_SECONDS = 0.12;

/**
 * Plays the probe out of the phone speaker so the phone's own microphone hears
 * it. The reply says only that it played and for which request - the server
 * derives the timing from its own round trip, because the client's clock is
 * not on the session's timeline and mapping it would be the very thing being
 * measured.
 */
function playCalibrationProbe(requestId, leadMs) {
  if (!audioContext || activeRole !== 'publisher') return;

  const startTime = audioContext.currentTime + leadMs / 1000;
  for (const offsetMs of PROBE_CLICK_OFFSETS_MS) {
    const at = startTime + offsetMs / 1000;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.frequency.value = PROBE_FREQUENCY_HZ;
    // Matches the reference's exp(-t * 55) envelope closely enough for the
    // envelope correlation the server runs; the shapes only have to agree.
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.35, at + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 1 / PROBE_CLICK_DECAY_PER_SECOND);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start(at);
    oscillator.stop(at + PROBE_CLICK_SECONDS);
  }

  if (socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({
    type: 'calibration-probe-played',
    target: 'mic',
    requestId,
    // The same truncation framePcm applies. The server compares this against
    // the generation it read off a PCM frame header, which is a uint32, so
    // sending the untruncated clock seed here never matches.
    generation: captureGeneration >>> 0,
  }));
}

function scheduleClick(time, accent) {
  if (!audioContext) return;
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.frequency.value = accent ? 1500 : 1000;
  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.exponentialRampToValueAtTime(accent ? 0.22 : 0.15, time + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.055);
  oscillator.connect(gain).connect(audioContext.destination);
  oscillator.start(time);
  oscillator.stop(time + 0.06);
}

function startLocalClickTrack() {
  stopLocalClickTrack();
  if (!audioContext || activeRole !== 'publisher') return;

  const beatSeconds = 60 / TEST_BPM;
  nextClickTime = audioContext.currentTime + 0.12;
  clickBeat = 0;

  const scheduleAhead = () => {
    if (!audioContext) return;
    while (nextClickTime < audioContext.currentTime + 0.15) {
      scheduleClick(nextClickTime, clickBeat % 4 === 0);
      nextClickTime += beatSeconds;
      clickBeat += 1;
    }
  };

  scheduleAhead();
  clickScheduler = setInterval(scheduleAhead, 25);
}

function stopLocalClickTrack() {
  if (clickScheduler) {
    clearInterval(clickScheduler);
    clickScheduler = null;
  }
}

function describeMonitorHealth() {
  if (!monitorHealth) return '';
  const parts = [`buffer ${Math.round(monitorHealth.queuedMs)} ms`];
  if (monitorHealth.underruns > 0) parts.push(`${monitorHealth.underruns} underruns`);
  if (monitorHealth.droppedMs > 20) parts.push(`trimmed ${Math.round(monitorHealth.droppedMs)} ms`);
  return ` · ${parts.join(' · ')}`;
}

function handleServerMessage(message) {
  if (message.type === 'error') {
    setStatus('Error', message.message);
    // The server now hands the publisher slot to the newest connection, so this
    // should not happen; if it ever does, keep trying rather than going silent.
    if (activeRole === 'publisher' && mediaStream && audioContext) schedulePublisherReconnect();
    return;
  }

  if (message.type === 'registered' && message.role === 'publisher' && activeRole === 'publisher') {
    setStatus('Microphone is live', `${audioContext?.sampleRate ?? '--'} Hz mono PCM → relay`);
    updateMixLabels();
    return;
  }

  if (message.type === 'publisher-status') {
    // Only meaningful while the raw microphone is being forwarded; a server mix
    // arrives at the mix rate no matter what the phone captures at.
    if (!serverMixActive()) sourceSampleRate = message.sampleRate ?? null;
    if (activeRole === 'monitor') {
      if (!message.connected) {
        playbackNode?.port.postMessage({ type: 'reset' });
        setStatus('Waiting for singer', 'Open this page on the phone and start the microphone.');
      } else if (!serverMixActive()) {
        setStatus('Singer connected', `Raw input: ${message.sampleRate} Hz · buffering audio…`);
      }
    }
    return;
  }

  if (message.type === 'source-status') {
    const wasLive = liveMixActive;
    liveMixActive = Boolean(message.active);
    updateCalibrateButton();

    if (liveMixActive) {
      sourceSampleRate = Number(message.mixSampleRate) || MIX_SAMPLE_RATE;
      if (!wasLive && activeRole === 'monitor') {
        playbackNode?.port.postMessage({ type: 'reset' });
        setStatus('Live mix', `Server mix · ${message.prebufferMs} ms buffer`);
      }
    } else if (wasLive) {
      sourceSampleRate = null;
      if (activeRole === 'monitor') playbackNode?.port.postMessage({ type: 'reset' });
    }
    return;
  }

  if (message.type === 'mix-settings') {
    if (!sliderIsBusy(micGain)) micGain.value = String(message.micGainDb ?? 24);
    if (!sliderIsBusy(songLevel)) songLevel.value = String(message.songLevel ?? 40);
    updateMixLabels();
    return;
  }

  if (message.type === 'timing-calibration-status') {
    latestCalibration = message;
    updateCalibrateButton();
    return;
  }

  if (message.type === 'play-calibration-probe') {
    // Backing requests are broadcast because the robot source page has no PCM
    // publisher role. The phone must ignore that leg or its faster reply can
    // be mistaken for the robot probe that is still waiting to play.
    if (message.target === undefined || message.target === 'mic') {
      playCalibrationProbe(message.requestId, Number(message.leadMs) || 200);
    }
    return;
  }

  if (message.type === 'mix-health') {
    latestMixHealth = message;
    renderGainAdvice();
    if (activeRole === 'monitor' && message.active && message.micStarvedFrames > 0) {
      setStatus(
        'Monitor playing · vocal starved',
        `Server ran out of buffered microphone on ${message.micStarvedFrames} frames ` +
        `(headroom ${message.micHeadroomMs} ms). Re-run Calibrate timing or check the phone link.`,
      );
    }
    return;
  }

  if (message.type === 'test-status') {
    const wasActive = testActive;
    testActive = Boolean(message.active);

    if (testActive) {
      sourceSampleRate = Number(message.sampleRate) || MIX_SAMPLE_RATE;
      if (activeRole === 'monitor') {
        playbackNode?.port.postMessage({ type: 'reset' });
        // The click track is deliberately harsh, so the test drops the monitor
        // to unity and restores the setting afterwards. This only ever made
        // sense for the test - it used to fire on live takes too, costing the
        // singer 30 dB and forgetting whatever they set during the take.
        monitorGain.value = '0';
        updateMonitorGain();
        setStatus('Sync test running', `${message.bpm} BPM · server mix · ${message.prebufferMs} ms safety buffer`);
      }
    } else {
      if (wasActive && activeRole === 'monitor') {
        playbackNode?.port.postMessage({ type: 'reset' });
        monitorGain.value = String(rawMonitorGainDb);
        updateMonitorGain();
      }
      if (activeRole === 'publisher') stopLocalClickTrack();
    }

    updateTestButtons();
  }
}

function canKeepPublishing() {
  return activeRole === 'publisher' && Boolean(mediaStream) && Boolean(audioContext);
}

function canKeepMonitoring() {
  return activeRole === 'monitor' && Boolean(audioContext) && Boolean(playbackNode);
}

function schedulePublisherReconnect() {
  if (!canKeepPublishing()) return;
  clearSocketReconnect();
  socketReconnectTimer = setTimeout(() => {
    socketReconnectTimer = null;
    connectPublisherSocket().catch(() => {
      if (!canKeepPublishing()) return;
      setStatus('Reconnecting microphone…', 'Relay is still unavailable; retrying automatically.');
      schedulePublisherReconnect();
    });
  }, SOCKET_RECONNECT_MS);
}

function scheduleMonitorReconnect() {
  if (!canKeepMonitoring()) return;
  clearSocketReconnect();
  socketReconnectTimer = setTimeout(() => {
    socketReconnectTimer = null;
    connectMonitorSocket().catch(() => {
      if (!canKeepMonitoring()) return;
      setStatus('Reconnecting monitor…', 'Relay is still unavailable; retrying automatically.');
      scheduleMonitorReconnect();
    });
  }, SOCKET_RECONNECT_MS);
}

function adoptSocket(ws) {
  const previous = socket;
  socket = ws;
  if (previous && previous !== ws) {
    try {
      previous.close();
    } catch {}
  }
}

async function connectPublisherSocket() {
  if (!canKeepPublishing()) return;
  clearSocketReconnect();

  const ws = await connectSocket();
  if (!canKeepPublishing()) {
    ws.close();
    return;
  }

  adoptSocket(ws);

  ws.send(JSON.stringify({
    type: 'register',
    role: 'publisher',
    sampleRate: audioContext.sampleRate,
  }));

  ws.addEventListener('message', (event) => {
    if (socket !== ws || typeof event.data !== 'string') return;
    handleServerMessage(JSON.parse(event.data));
  });

  ws.addEventListener('close', () => {
    if (socket !== ws) return;
    socket = null;
    if (!canKeepPublishing()) return;
    setStatus('Reconnecting microphone…', 'Relay connection closed; microphone capture stays active.');
    schedulePublisherReconnect();
  });

  ws.addEventListener('error', () => {
    try {
      ws.close();
    } catch {}
  });
}

async function connectMonitorSocket() {
  if (!canKeepMonitoring()) return;
  clearSocketReconnect();

  const ws = await connectSocket();
  if (!canKeepMonitoring()) {
    ws.close();
    return;
  }

  adoptSocket(ws);
  playbackNode.port.postMessage({ type: 'reset' });
  ws.send(JSON.stringify({ type: 'register', role: 'monitor' }));

  ws.addEventListener('message', (event) => {
    if (socket !== ws) return;

    if (typeof event.data === 'string') {
      handleServerMessage(JSON.parse(event.data));
      return;
    }

    if (!(event.data instanceof ArrayBuffer) || !audioContext || !playbackNode) return;
    // Falling back beats discarding audio: every server-mixed frame is 48 kHz,
    // and dropping frames here used to look exactly like "no audio at all".
    const rate = sourceSampleRate || MIX_SAMPLE_RATE;
    const pcm = int16ToFloat32(event.data);
    const samples = linearResample(pcm, rate, audioContext.sampleRate);
    playbackNode.port.postMessage(samples.buffer, [samples.buffer]);
  });

  ws.addEventListener('close', () => {
    if (socket !== ws) return;
    socket = null;
    if (!canKeepMonitoring()) {
      setStatus('Disconnected', 'The relay connection closed.');
      return;
    }
    setStatus('Reconnecting monitor…', 'Relay connection closed; retrying automatically.');
    scheduleMonitorReconnect();
  });

  ws.addEventListener('error', () => {
    try {
      ws.close();
    } catch {}
  });
}

async function stop(setIdle = true) {
  stopLocalClickTrack();
  clearSocketReconnect();
  setActiveRole(null);
  if (socket) {
    socket.close();
    socket = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }
  if (activeNode) {
    try {
      activeNode.disconnect();
    } catch {}
    activeNode = null;
  }
  playbackNode = null;
  monitorGainNode = null;
  if (audioContext) {
    await audioContext.close();
    audioContext = null;
  }
  sourceSampleRate = null;
  testActive = false;
  liveMixActive = false;
  uplinkDroppedChunks = 0;
  monitorHealth = null;
  publisherButton.disabled = false;
  monitorButton.disabled = false;
  stopButton.disabled = true;
  updateTestButtons();
  if (setIdle) setStatus('Idle', 'Choose one role on each device.');
}

async function startPublisher() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Microphone capture is unavailable. On a phone, open Relay through HTTPS.');
  }
  await stop();
  setStatus('Starting microphone…');

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
    video: false,
  });

  audioContext = new AudioContext({ latencyHint: 'interactive' });
  await audioContext.audioWorklet.addModule('/capture-worklet.js');
  await audioContext.resume();

  setActiveRole('publisher');

  // A new capture session. Reconnecting the websocket does not bump this: the
  // capture keeps running and its sample cursor stays continuous, so the server
  // can place the reconnected frames on the timeline they already belonged to.
  captureGeneration += 1;
  captureSampleCursor = 0;

  const [track] = mediaStream.getAudioTracks();
  track?.addEventListener('ended', () => {
    setStatus('Microphone stopped', 'The audio input ended. Press Microphone again to restart it.');
  });

  const source = audioContext.createMediaStreamSource(mediaStream);
  const capture = new AudioWorkletNode(audioContext, 'capture-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  const silent = audioContext.createGain();
  silent.gain.value = 0;

  capture.port.onmessage = (event) => {
    if (!(event.data instanceof ArrayBuffer)) {
      if (event.data?.type === 'input-gap') {
        console.warn('Microphone input gap', event.data.quanta, 'quanta padded with silence');
      }
      return;
    }

    // The cursor advances for every captured chunk, including ones that are
    // never sent, so the server can see exactly what is missing. It also keeps
    // counting through a websocket outage, which is what lets the stream rejoin
    // the same timeline without the mix restarting.
    const firstSampleIndex = captureSampleCursor;
    captureSampleCursor += event.data.byteLength / 2;

    if (socket?.readyState !== WebSocket.OPEN) return;

    if (socket.bufferedAmount >= 256 * 1024) {
      uplinkDroppedChunks += 1;
      const now = performance.now();
      if (now - lastUplinkWarningAt > 2000) {
        lastUplinkWarningAt = now;
        setStatus(
          'Microphone uplink congested',
          `Dropped ${uplinkDroppedChunks} chunks (~${uplinkDroppedChunks * 20} ms). ` +
          'The gap is reported to the server, but the vocal is missing for that stretch.',
        );
      }
      return;
    }

    socket.send(framePcm(event.data, captureGeneration, firstSampleIndex));
  };

  source.connect(capture).connect(silent).connect(audioContext.destination);
  activeNode = capture;

  publisherButton.disabled = true;
  monitorButton.disabled = true;
  stopButton.disabled = false;
  updateTestButtons();
  setStatus('Connecting microphone…', `${audioContext.sampleRate} Hz capture is active; connecting to Relay.`);

  try {
    await connectPublisherSocket();
  } catch {
    setStatus('Reconnecting microphone…', 'Initial Relay connection failed; retrying automatically.');
    schedulePublisherReconnect();
  }
}

async function startMonitor() {
  await stop();
  setStatus('Starting monitor…');

  audioContext = new AudioContext({ latencyHint: 'interactive' });
  await audioContext.audioWorklet.addModule('/playback-worklet.js');
  await audioContext.resume();

  const playback = new AudioWorkletNode(audioContext, 'playback-processor', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  playback.port.postMessage({
    type: 'configure',
    prebufferMs: MONITOR_PREBUFFER_MS,
    maxQueueMs: MONITOR_MAX_QUEUE_MS,
  });

  monitorGainNode = audioContext.createGain();
  monitorGainNode.gain.value = dbToGain(Number(monitorGain.value));
  playback.connect(monitorGainNode).connect(audioContext.destination);
  activeNode = playback;
  playbackNode = playback;

  playback.port.onmessage = (event) => {
    if (event.data?.type === 'health') {
      monitorHealth = event.data;
      return;
    }
    if (event.data?.type === 'buffering') setStatus('Monitor buffering…', 'Waiting for enough audio.');
    if (event.data?.type === 'playing' && !testActive) {
      setStatus('Monitor playing', `Output: ${audioContext.sampleRate} Hz · gain ${monitorGainValue.value}${describeMonitorHealth()}`);
    }
  };

  setActiveRole('monitor');

  publisherButton.disabled = true;
  monitorButton.disabled = true;
  stopButton.disabled = false;
  updateTestButtons();

  try {
    await connectMonitorSocket();
  } catch {
    setStatus('Reconnecting monitor…', 'Initial Relay connection failed; retrying automatically.');
    scheduleMonitorReconnect();
  }
}

publisherButton.addEventListener('click', () => {
  startPublisher().catch(async (error) => {
    console.error(error);
    setStatus('Could not start microphone', error instanceof Error ? error.message : String(error));
    await stop(false);
  });
});

monitorButton.addEventListener('click', () => {
  startMonitor().catch(async (error) => {
    console.error(error);
    setStatus('Could not start monitor', error instanceof Error ? error.message : String(error));
    await stop(false);
  });
});

stopButton.addEventListener('click', () => {
  stop().catch(console.error);
});

testStartButton.addEventListener('click', () => {
  if (activeRole !== 'publisher' || socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: 'start-sync-test' }));
  startLocalClickTrack();
});

testStopButton.addEventListener('click', () => {
  if (socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: 'stop-sync-test' }));
  stopLocalClickTrack();
});

monitorGain.addEventListener('input', updateMonitorGain);

for (const slider of [micGain, songLevel]) {
  slider.addEventListener('input', () => {
    markSliderTouched(slider);
    sendMixSettings();
  });
  slider.addEventListener('change', () => markSliderTouched(slider));
}

calibrateButton.addEventListener('click', () => {
  if (socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: 'start-timing-calibration' }));
});

updateMonitorGain();
updateMixLabels();
updateCalibrateButton();
updateTestButtons();
setStatus('Idle', 'On the phone choose Microphone; on the computer choose Monitor.');
