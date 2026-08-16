const publisherButton = document.querySelector('#start-publisher');
const testStartButton = document.querySelector('#start-sync-test');
const testStopButton = document.querySelector('#stop-sync-test');
const status = document.querySelector('#status');
const details = document.querySelector('#details');
const micGain = document.querySelector('#mic-gain');
const micGainValue = document.querySelector('#mic-gain-value');
const micGainAdvice = document.querySelector('#mic-gain-advice');
const micInputMeter = document.querySelector('#mic-input-meter');
const micInputValue = document.querySelector('#mic-input-value');
const micGainRecommendation = document.querySelector('#mic-gain-recommendation');
const micGainRecommendationMarker = document.querySelector('#mic-gain-recommendation-marker');
const useMicGainSuggestion = document.querySelector('#use-mic-gain-suggestion');
const songLevel = document.querySelector('#song-level');
const songLevelValue = document.querySelector('#song-level-value');
const calibrateButton = document.querySelector('#calibrate-timing');
const calibrateStatus = document.querySelector('#calibrate-status');

const TEST_BPM = 120;
const SOCKET_RECONNECT_MS = 1000;
const SLIDER_HOLD_MS = 2000;

let socket = null;
let socketReconnectTimer = null;
let audioContext = null;
let mediaStream = null;
let activeNode = null;
let publisherActive = false;
let testActive = false;
let liveMixActive = false;
let latestMixHealth = null;
let latestCalibration = null;
let pendingPublisherTakeoverOwnerId = null;

/**
 * The same measured advice source.html shows, put where the singer can act on
 * it. Mic gain is one server value with a slider on each page, and the person
 * whose voice decides the right setting is holding the phone - they cannot see
 * the desktop screen while singing.
 */
function renderGainAdvice() {
  if (
    !micGainAdvice || !micInputMeter || !micInputValue
    || !micGainRecommendation || !micGainRecommendationMarker || !useMicGainSuggestion
  ) return;

  const rawPeak = latestMixHealth?.micPeakDbfs;
  const rawRecommended = latestMixHealth?.recommendedMicGainDb;
  const peak = rawPeak === null || rawPeak === undefined ? Number.NaN : Number(rawPeak);
  const recommended = rawRecommended === null || rawRecommended === undefined
    ? Number.NaN
    : Number(rawRecommended);

  if (Number.isFinite(peak)) {
    // Evidence only: the rail shows the measured input, not another setting.
    // -60 dBFS maps to the quiet edge and 0 dBFS to full scale.
    const inputPercent = Math.max(0, Math.min(100, ((peak + 60) / 60) * 100));
    micInputMeter.style.setProperty('--input-level', `${inputPercent}%`);
    micInputValue.value = `${peak.toFixed(1)} dBFS`;
  } else {
    micInputMeter.style.setProperty('--input-level', '0%');
    micInputValue.value = 'Listening…';
  }

  const current = Math.round(Number(micGain.value) || 0);
  if (!Number.isFinite(recommended)) {
    micGainRecommendationMarker.hidden = true;
    micGainRecommendation.textContent = 'Sing normally for a moment.';
    micGainAdvice.textContent = 'Relay will suggest a stable gain after it has enough voice.';
    useMicGainSuggestion.hidden = true;
    return;
  }

  const suggested = Math.max(0, Math.min(36, Math.round(recommended)));
  const markerPercent = (suggested / 36) * 100;
  micGainRecommendationMarker.hidden = false;
  micGainRecommendationMarker.style.left = `${markerPercent}%`;
  micGainRecommendation.textContent = `Recommended +${suggested} dB`;

  const off = suggested - current;
  micGainAdvice.textContent = Math.abs(off) <= 3
    ? 'Sounds good'
    : off < 0
      ? `${-off} dB above suggestion`
      : `${off} dB below suggestion`;

  const canApply = publisherActive && Math.abs(off) > 3;
  useMicGainSuggestion.hidden = !canApply;
  useMicGainSuggestion.disabled = !publisherActive;
  useMicGainSuggestion.textContent = `Use +${suggested} dB`;
}
let clickScheduler = null;
let nextClickTime = 0;
let clickBeat = 0;
let uplinkDroppedChunks = 0;
let lastUplinkWarningAt = 0;
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

const COMMAND_LABELS = {
  'set-mix': 'Mix is controlled by the singer',
  'set-vocal-fine-tune': 'Vocal timing is controlled by the singer',
  'start-timing-calibration': 'Calibration is controlled by the singer',
  'start-sync-test': 'The sync test is controlled by the singer',
  'stop-sync-test': 'The sync test is controlled by the singer',
};

function setPublisherActive(active) {
  publisherActive = Boolean(active);
  // listen.js only needs to know whether this phone is the singer phone.
  // Keep the old global shape temporarily while the Mic controller remains in app.js.
  window.relayActiveRole = publisherActive ? 'publisher' : null;
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

function updateMixLabels() {
  micGainValue.value = signed(micGain.value, ' dB');
  songLevelValue.value = `${Math.round(Number(songLevel.value) || 0)}%`;
  // The verdict compares the slider against the meter, so it moves with both.
  renderGainAdvice();
}

function sendMixSettings() {
  updateMixLabels();
  if (socket?.readyState !== WebSocket.OPEN || !publisherActive) return;
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
  testStartButton.disabled = !publisherActive || testActive;
  testStopButton.disabled = !publisherActive || !testActive;
  micGain.disabled = !publisherActive;
  songLevel.disabled = !publisherActive;
  renderGainAdvice();
  // Same dependency on publisher state, so it rides along rather than needing a
  // call at every site that changes roles.
  updateCalibrateButton();
}

/**
 * Calibration runs itself, but the singer is the one who can hear that it got
 * it wrong, and they are not at the machine the other button is on.
 */
function updateCalibrateButton() {
  const collecting = latestCalibration?.state === 'collecting';
  calibrateButton.disabled = !publisherActive || !liveMixActive || collecting;

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
  const source = new URLSearchParams(location.search);
  const params = new URLSearchParams();
  const key = source.get('key');
  if (key) params.set('key', key);

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

// Must match src/calibration-probe.ts, which builds the reference the server
// correlates against. Irregular offsets are the point: no shift other than the
// true one lines all three notes up at once, which is exactly the ambiguity
// correlating against a song's own beat cannot escape.
const PROBE_NOTES = [
  { offsetMs: 0, frequencyHz: 1046.5, gain: 0.24 },
  { offsetMs: 125, frequencyHz: 1318.5, gain: 0.27 },
  { offsetMs: 330, frequencyHz: 1568, gain: 0.32 },
];
const PROBE_NOTE_SECONDS = 0.105;

/**
 * Plays the probe out of the phone speaker so the phone's own microphone hears
 * it. The reply says only that it played and for which request - the server
 * derives the timing from its own round trip, because the client's clock is
 * not on the session's timeline and mapping it would be the very thing being
 * measured.
 */
function playCalibrationProbe(requestId, leadMs) {
  if (!audioContext || !publisherActive) return;

  const startTime = audioContext.currentTime + leadMs / 1000;
  for (const note of PROBE_NOTES) {
    const at = startTime + note.offsetMs / 1000;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.frequency.value = note.frequencyHz;
    // A slightly softened attack avoids a sharp test-beep edge. The decay is
    // close to the reference envelope used by the server's correlation.
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(note.gain, at + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + PROBE_NOTE_SECONDS);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start(at);
    oscillator.stop(at + PROBE_NOTE_SECONDS);
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
  if (!audioContext || !publisherActive) return;

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

function dispatchRelayEvent(type, detail = {}) {
  window.dispatchEvent(new CustomEvent(type, { detail }));
}

function handleServerMessage(message) {
  if (message.type === 'error') {
    setStatus('Error', message.message);
    // Protocol errors are not transport failures. Retrying the publisher after
    // a semantic rejection used to make superseded tabs fight forever.
    return;
  }

  if (message.type === 'command-rejected') {
    // Without this the control simply stops working: the slider moves, the
    // server drops the command, and nothing on the page says why.
    const owner = message.owner ?? null;
    setStatus(
      COMMAND_LABELS[message.command] ?? 'Command refused',
      message.reason === 'not-mic-owner'
        ? `${owner ? owner.nickname : 'Another participant'} has the mic and controls this.`
        : 'Join the room with a name before changing this.',
    );
    return;
  }

  if (message.type === 'mic-busy') {
    const owner = message.owner ?? null;
    setStatus('Microphone is in use', owner ? `${owner.nickname} has the mic.` : 'Another participant has the mic.');
    dispatchRelayEvent('relay-mic-busy', { owner });
    stop(false, { releaseMic: false }).catch(console.error);
    return;
  }

  if (message.type === 'mic-takeover-rejected') {
    const owner = message.owner ?? null;
    setStatus('Takeover changed', owner ? `${owner.nickname} has the mic now.` : 'The mic state changed.');
    dispatchRelayEvent('relay-mic-takeover-rejected', { owner, reason: message.reason });
    stop(false, { releaseMic: false }).catch(console.error);
    return;
  }

  if (message.type === 'mic-revoked') {
    setStatus('Microphone handed off', message.message ?? 'Another participant now has the mic.');
    dispatchRelayEvent('relay-microphone-ended', { reason: 'revoked' });
    stop(false, { releaseMic: false }).catch(console.error);
    return;
  }

  if (message.type === 'publisher-superseded') {
    setStatus('Microphone moved to another tab', message.message ?? 'A newer microphone capture is active.');
    dispatchRelayEvent('relay-microphone-ended', { reason: 'superseded' });
    stop(false, { releaseMic: false }).catch(console.error);
    return;
  }

  if (message.type === 'registered' && message.role === 'publisher' && publisherActive) {
    pendingPublisherTakeoverOwnerId = null;
    setStatus('Microphone is live', `${audioContext?.sampleRate ?? '--'} Hz mono PCM → relay`);
    updateMixLabels();
    dispatchRelayEvent('relay-microphone-started');
    return;
  }

  if (message.type === 'source-status') {
    liveMixActive = Boolean(message.active);
    updateCalibrateButton();
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
    return;
  }

  if (message.type === 'test-status') {
    testActive = Boolean(message.active);
    if (!testActive && publisherActive) stopLocalClickTrack();
    updateTestButtons();
  }
}

function canKeepPublishing() {
  return publisherActive && Boolean(mediaStream) && Boolean(audioContext);
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

  const registration = {
    type: 'register',
    role: 'publisher',
    sampleRate: audioContext.sampleRate,
    captureGeneration: captureGeneration >>> 0,
  };
  if (pendingPublisherTakeoverOwnerId) {
    registration.takeoverExpectedOwnerId = pendingPublisherTakeoverOwnerId;
  }
  ws.send(JSON.stringify(registration));

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

async function stop(setIdle = true, { releaseMic = true } = {}) {
  stopLocalClickTrack();
  clearSocketReconnect();

  const closingSocket = socket;
  const shouldReleaseMic = releaseMic && publisherActive;
  if (shouldReleaseMic && closingSocket?.readyState === WebSocket.OPEN) {
    try {
      closingSocket.send(JSON.stringify({ type: 'release-mic' }));
    } catch {}
  }

  setPublisherActive(false);
  pendingPublisherTakeoverOwnerId = null;
  if (closingSocket) {
    try {
      closingSocket.close();
    } catch {}
    if (socket === closingSocket) socket = null;
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
  if (audioContext) {
    await audioContext.close();
    audioContext = null;
  }
  testActive = false;
  liveMixActive = false;
  uplinkDroppedChunks = 0;
  publisherButton.disabled = false;
  updateTestButtons();
  if (setIdle) setStatus('Idle', 'Take the mic when you are ready.');
}

async function startPublisher(takeoverExpectedOwnerId = null) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Microphone capture is unavailable. On a phone, open Relay through HTTPS.');
  }
  await stop();
  pendingPublisherTakeoverOwnerId = takeoverExpectedOwnerId;
  setStatus('Starting microphone…');

  // Capture is prepared before the server is allowed to change ownership. A
  // denied permission or failed AudioWorklet therefore leaves the current
  // singer untouched.
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

  setPublisherActive(true);

  // A new capture session. Reconnecting the websocket does not bump this: the
  // capture keeps running and its sample cursor stays continuous, so the server
  // can place the reconnected frames on the timeline they already belonged to.
  captureGeneration += 1;
  captureSampleCursor = 0;

  const [track] = mediaStream.getAudioTracks();
  track?.addEventListener('ended', () => {
    if (!publisherActive) return;
    stop(false, { releaseMic: true })
      .then(() => setStatus('Microphone stopped', 'The audio input ended. Press Microphone again to restart it.'))
      .catch(console.error);
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
  updateTestButtons();
  setStatus('Connecting microphone…', `${audioContext.sampleRate} Hz capture is active; connecting to Relay.`);

  try {
    await connectPublisherSocket();
  } catch {
    setStatus('Reconnecting microphone…', 'Initial Relay connection failed; retrying automatically.');
    schedulePublisherReconnect();
  }
}

async function requestPublisherStart(takeoverExpectedOwnerId = null) {
  try {
    await startPublisher(takeoverExpectedOwnerId);
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : String(error);
    setStatus('Could not start microphone', message);
    dispatchRelayEvent('relay-microphone-start-failed', {
      message,
      takeoverExpectedOwnerId,
    });
    await stop(false, { releaseMic: false });
  }
}

publisherButton.addEventListener('click', () => {
  requestPublisherStart().catch(console.error);
});

window.addEventListener('relay-request-microphone', (event) => {
  const expectedOwnerId = typeof event.detail?.takeoverExpectedOwnerId === 'string'
    ? event.detail.takeoverExpectedOwnerId
    : null;
  requestPublisherStart(expectedOwnerId).catch(console.error);
});

testStartButton.addEventListener('click', () => {
  if (!publisherActive || socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: 'start-sync-test' }));
  startLocalClickTrack();
});

testStopButton.addEventListener('click', () => {
  if (socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: 'stop-sync-test' }));
  stopLocalClickTrack();
});

for (const slider of [micGain, songLevel]) {
  slider.addEventListener('input', () => {
    markSliderTouched(slider);
    sendMixSettings();
  });
  slider.addEventListener('change', () => markSliderTouched(slider));
}

useMicGainSuggestion.addEventListener('click', () => {
  const recommended = Number(latestMixHealth?.recommendedMicGainDb);
  if (!publisherActive || !Number.isFinite(recommended)) return;
  micGain.value = String(Math.max(0, Math.min(36, Math.round(recommended))));
  markSliderTouched(micGain);
  sendMixSettings();
});

calibrateButton.addEventListener('click', () => {
  if (socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: 'start-timing-calibration' }));
});

updateMixLabels();
updateCalibrateButton();
updateTestButtons();
setStatus('Idle', 'Take the mic when you are ready.');
