import { PreferredAudioTransport } from './audio-transport.js';
import { splitPcmForPacketLimit } from './audio-packetizer.js';

const publisherButton = document.querySelector('#start-publisher');
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

const SOCKET_RECONNECT_MS = 1000;
const SLIDER_HOLD_MS = 2000;
const AUDIO_UPLINK_HEALTH_INTERVAL_MS = 1000;

let socket = null;
let socketReconnectTimer = null;
let audioContext = null;
let mediaStream = null;
let activeNode = null;
let publisherActive = false;
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
let uplinkDroppedSamples = 0;
let uplinkDroppedSamplesByReason = { disconnected: 0, congested: 0, packetTooLarge: 0 };
let captureInputGapSamples = 0;
let publisherControlConnections = 0;
let audioUplinkHealthTimer = null;
let lastUplinkWarningAt = 0;
// Seeded from the clock, not 0: a page reload starts a new module scope and
// would otherwise reuse the same first-ever generation number, which the
// server take as "nothing changed" and skip re-anchoring the mic timeline to
// the new capture. Wire format is a Uint32 (see framePcm below); the seconds
// component keeps this unique across any reload that is not the same
// millisecond as a previous one, which a real reload never is.
let captureGeneration = Date.now();
let captureSampleCursor = 0;
let capturePacketSequence = 0;

// AudioPacket v2 keeps transport order (`sequence`) separate from capture time
// (`firstSampleIndex`). The server accepts this strictly after registration;
// malformed v2 can never fall back to being interpreted as raw PCM.
const AUDIO_PACKET_MAGIC = 0x4c52;
const AUDIO_PACKET_VERSION = 2;
const AUDIO_PACKET_HEADER_BYTES = 24;
const AUDIO_PACKET_SOURCE_MIC = 1;

const audioTransport = new PreferredAudioTransport({
  maxBufferedBytes: 256 * 1024,
  minimumPacketBytes: AUDIO_PACKET_HEADER_BYTES + 2,
});

function framePcm(pcm, generation, sequence, firstSampleIndex) {
  const packet = new ArrayBuffer(AUDIO_PACKET_HEADER_BYTES + pcm.byteLength);
  const view = new DataView(packet);
  view.setUint16(0, AUDIO_PACKET_MAGIC, true);
  view.setUint8(2, AUDIO_PACKET_VERSION);
  view.setUint8(3, AUDIO_PACKET_SOURCE_MIC);
  view.setUint32(4, generation >>> 0, true);
  view.setUint32(8, sequence >>> 0, true);
  view.setUint32(12, pcm.byteLength / 2, true);
  view.setFloat64(16, firstSampleIndex, true);
  new Uint8Array(packet, AUDIO_PACKET_HEADER_BYTES).set(new Uint8Array(pcm));
  return packet;
}

function recordUplinkDrop(sampleCount, reason) {
  if (!Number.isFinite(sampleCount) || sampleCount <= 0) return;
  uplinkDroppedSamples += sampleCount;
  if (reason === 'disconnected') uplinkDroppedSamplesByReason.disconnected += sampleCount;
  else if (reason === 'congested') uplinkDroppedSamplesByReason.congested += sampleCount;
  else if (reason === 'packet-too-large') uplinkDroppedSamplesByReason.packetTooLarge += sampleCount;
  if (reason === 'disconnected') return;

  const now = performance.now();
  if (now - lastUplinkWarningAt <= 2000) return;
  lastUplinkWarningAt = now;
  const sampleRate = audioContext?.sampleRate ?? 48000;
  const droppedMs = Math.round((uplinkDroppedSamples * 1000) / sampleRate);
  const title = reason === 'packet-too-large'
    ? 'Microphone datagram budget changed'
    : 'Microphone uplink congested';
  setStatus(
    title,
    `Dropped about ${droppedMs} ms of microphone audio. ` +
    'The sample timeline keeps the hole in the right place instead of pulling later audio earlier.',
  );
}

function audioUplinkHealthPayload() {
  return {
    type: 'audio-uplink-health',
    version: 1,
    captureGeneration: captureGeneration >>> 0,
    capturedSamples: captureSampleCursor,
    inputGapSamples: captureInputGapSamples,
    droppedSamples: { total: uplinkDroppedSamples, ...uplinkDroppedSamplesByReason },
    controlReconnects: Math.max(0, publisherControlConnections - 1),
    transport: audioTransport.stats(),
  };
}

function sendAudioUplinkHealth() {
  if (!publisherActive || socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(audioUplinkHealthPayload()));
}

function startAudioUplinkHealthReporting() {
  if (audioUplinkHealthTimer !== null) clearInterval(audioUplinkHealthTimer);
  audioUplinkHealthTimer = setInterval(sendAudioUplinkHealth, AUDIO_UPLINK_HEALTH_INTERVAL_MS);
}

function stopAudioUplinkHealthReporting() {
  if (audioUplinkHealthTimer !== null) clearInterval(audioUplinkHealthTimer);
  audioUplinkHealthTimer = null;
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

function updateSingerControls() {
  micGain.disabled = !publisherActive;
  songLevel.disabled = !publisherActive;
  renderGainAdvice();
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
    void audioTransport.prefer(message.mediaTransport ?? null).then((preferred) => {
      if (!publisherActive) return;
      const path = preferred ? 'WebTransport datagrams' : 'WebSocket fallback';
      setStatus('Microphone is live', `${audioContext?.sampleRate ?? '--'} Hz mono PCM · ${path}`);
      sendAudioUplinkHealth();
    });
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
    audioPacketVersion: AUDIO_PACKET_VERSION,
  };
  if (pendingPublisherTakeoverOwnerId) {
    registration.takeoverExpectedOwnerId = pendingPublisherTakeoverOwnerId;
  }
  ws.send(JSON.stringify(registration));
  audioTransport.bind(ws);
  publisherControlConnections += 1;

  ws.addEventListener('message', (event) => {
    if (socket !== ws || typeof event.data !== 'string') return;
    handleServerMessage(JSON.parse(event.data));
  });

  ws.addEventListener('close', () => {
    if (socket !== ws) return;
    audioTransport.unbind(ws);
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
  clearSocketReconnect();
  stopAudioUplinkHealthReporting();

  const closingSocket = socket;
  const shouldReleaseMic = releaseMic && publisherActive;
  if (shouldReleaseMic && closingSocket?.readyState === WebSocket.OPEN) {
    try {
      closingSocket.send(JSON.stringify({ type: 'release-mic' }));
    } catch {}
  }

  if (publisherActive) audioTransport.close();
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
  liveMixActive = false;
  uplinkDroppedSamples = 0;
  uplinkDroppedSamplesByReason = { disconnected: 0, congested: 0, packetTooLarge: 0 };
  captureInputGapSamples = 0;
  publisherControlConnections = 0;
  publisherButton.disabled = false;
  updateSingerControls();
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
  capturePacketSequence = 0;
  captureInputGapSamples = 0;
  uplinkDroppedSamples = 0;
  uplinkDroppedSamplesByReason = { disconnected: 0, congested: 0, packetTooLarge: 0 };
  publisherControlConnections = 0;
  audioTransport.resetStats();
  startAudioUplinkHealthReporting();

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
        const samples = Number(event.data.samples);
        if (Number.isSafeInteger(samples) && samples > 0) captureInputGapSamples += samples;
        console.warn(
          'Microphone input gap',
          event.data.quanta,
          'quanta padded with silence',
          event.data.recovered ? '(recovered)' : '(continuing)',
        );
      }
      return;
    }

    // Capture time advances once for the complete worklet chunk. Packetization
    // may split the PCM to the live datagram budget, but each segment keeps its
    // exact firstSampleIndex on the same capture timeline.
    const chunkFirstSampleIndex = captureSampleCursor;
    captureSampleCursor += event.data.byteLength / 2;

    const pending = splitPcmForPacketLimit(
      event.data,
      audioTransport.maxPacketBytes(),
      AUDIO_PACKET_HEADER_BYTES,
    ).map((segment) => ({
      pcm: segment.pcm,
      sampleOffset: segment.sampleOffset,
    }));

    while (pending.length > 0) {
      const segment = pending.shift();
      const firstSampleIndex = chunkFirstSampleIndex + segment.sampleOffset;
      const sequence = capturePacketSequence;
      const packet = framePcm(segment.pcm, captureGeneration, sequence, firstSampleIndex);
      let sendResult = audioTransport.send(packet);

      if (!sendResult.sent && sendResult.reason === 'packet-too-large') {
        const retryLimit = audioTransport.maxPacketBytes();
        if (!Number.isFinite(retryLimit)) {
          sendResult = audioTransport.send(packet);
        } else {
          try {
            const smaller = splitPcmForPacketLimit(
              segment.pcm,
              retryLimit,
              AUDIO_PACKET_HEADER_BYTES,
            );
            if (smaller.length > 1) {
              for (let index = smaller.length - 1; index >= 0; index -= 1) {
                pending.unshift({
                  pcm: smaller[index].pcm,
                  sampleOffset: segment.sampleOffset + smaller[index].sampleOffset,
                });
              }
              continue;
            }
          } catch {}
        }
      }

      if (sendResult.sent) {
        capturePacketSequence = (capturePacketSequence + 1) >>> 0;
        continue;
      }

      if (
        sendResult.reason === 'disconnected'
        || sendResult.reason === 'congested'
        || sendResult.reason === 'packet-too-large'
      ) {
        recordUplinkDrop(segment.pcm.byteLength / 2, sendResult.reason);
      }
    }
  };

  source.connect(capture).connect(silent).connect(audioContext.destination);
  activeNode = capture;

  publisherButton.disabled = true;
  updateSingerControls();
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
updateSingerControls();
setStatus('Idle', 'Take the mic when you are ready.');
