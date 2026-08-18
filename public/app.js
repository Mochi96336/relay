import { sendParticipantAuthentication } from './participant-auth.js';
await window.relayIdentityReady;
import { PreferredAudioTransport } from './audio-transport.js';
import { shouldRequestAudioResume } from './audio-context-recovery.js';
import { MicStartupCancelledError, MicStartupGate } from './mic-startup.js';
const t = (key, vars) => window.relayI18n?.t(key, vars) ?? key;
import { splitPcmForPacketLimit } from './audio-packetizer.js';

const publisherButton = document.querySelector('#start-publisher');
const releaseButton = document.querySelector('#release-mic');
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
const vocalFineTune = document.querySelector('#vocal-fine-tune');
const vocalFineTuneValue = document.querySelector('#vocal-fine-tune-value');
const calibrateButton = document.querySelector('#calibrate-timing');
const calibrateStatus = document.querySelector('#calibrate-status');

const SOCKET_RECONNECT_MS = 1000;
const SLIDER_HOLD_MS = 2000;
const AUDIO_UPLINK_HEALTH_INTERVAL_MS = 1000;
const MAX_MIC_GAIN_DB = 40;
const MAX_RECOMMENDED_MIC_GAIN_DB = 36;
const FIXED_SONG_LEVEL = 100;

let socket = null;
let socketReconnectTimer = null;
let audioContext = null;
let mediaStream = null;
let activeNode = null;
let publisherActive = false;
let publisherStarting = false;
let publisherStartRequest = null;
const micStartup = new MicStartupGate();
let liveMixActive = false;
let latestMixHealth = null;
let latestLocalMicLevel = null;
let latestCalibration = null;
let roomSongAvailable = null;
let roomCanStartCalibration = null;
let pendingPublisherTakeoverOwnerId = null;
let activeCalibrationProbeRequestId = null;
let publisherSessionEpoch = 0;

/**
 * The local capture owns the live meter; server mix health owns slower gain
 * advice. Keeping those evidence paths separate prevents a 1 Hz health cadence
 * from masquerading as a realtime microphone display.
 */
function renderGainAdvice() {
  if (
    !micGainAdvice || !micInputMeter || !micInputValue
    || !micGainRecommendation || !micGainRecommendationMarker || !useMicGainSuggestion
  ) return;

  const rawPeak = latestLocalMicLevel?.peakDbfs;
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
    micInputValue.value = t('adjust.listening');
  }

  const current = Math.round(Number(micGain.value) || 0);
  if (!Number.isFinite(recommended)) {
    micGainRecommendationMarker.hidden = true;
    micGainRecommendation.textContent = t('adjust.singNormally');
    micGainAdvice.textContent = t('adjust.suggestionHelp');
    useMicGainSuggestion.hidden = true;
    return;
  }

  // Relay's automatic recommendation remains deliberately conservative. The
  // last 4 dB of the rail is manual headroom, not a target the product should
  // push a singer toward automatically.
  const suggested = Math.max(0, Math.min(MAX_RECOMMENDED_MIC_GAIN_DB, Math.round(recommended)));
  const markerPercent = (suggested / MAX_MIC_GAIN_DB) * 100;
  micGainRecommendationMarker.hidden = false;
  micGainRecommendationMarker.style.left = `${markerPercent}%`;
  micGainRecommendation.textContent = t('adjust.recommendedGain', { gain: suggested });

  const off = suggested - current;
  micGainAdvice.textContent = Math.abs(off) <= 3
    ? t('adjust.soundsGood')
    : off < 0
      ? t('adjust.aboveSuggestion', { amount: -off })
      : t('adjust.belowSuggestion', { amount: off });

  const canApply = publisherActive && Math.abs(off) > 3;
  useMicGainSuggestion.hidden = !canApply;
  useMicGainSuggestion.disabled = !publisherActive;
  useMicGainSuggestion.textContent = t('adjust.useGain', { gain: suggested });
}
let uplinkDroppedSamples = 0;
let uplinkDroppedSamplesByReason = { disconnected: 0, congested: 0, packetTooLarge: 0 };
let captureInputGapSamples = 0;
let captureInputMuted = false;
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
    inputMuted: captureInputMuted,
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
  // listen.js / recorder.js consume the legacy role, while Presence consumes
  // the explicit local lifecycle event so Release never depends on a server
  // ownership snapshot arriving first.
  window.relayActiveRole = publisherActive ? 'publisher' : null;
  releaseButton.hidden = !publisherActive;
  dispatchRelayEvent('relay-microphone-local-state', { active: publisherActive });
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

function updateVocalFineTuneLabel() {
  vocalFineTuneValue.value = signed(vocalFineTune.value, ' ms');
}

function sendVocalFineTune() {
  updateVocalFineTuneLabel();
  if (socket?.readyState !== WebSocket.OPEN || !publisherActive) return;
  socket.send(JSON.stringify({
    type: 'set-vocal-fine-tune',
    valueMs: Number(vocalFineTune.value),
  }));
}

function sendMixSettings() {
  updateMixLabels();
  if (socket?.readyState !== WebSocket.OPEN || !publisherActive) return;
  socket.send(JSON.stringify({
    type: 'set-mix',
    micGainDb: Number(micGain.value),
    // Retain the old field on the wire while the server owns its only valid
    // value. It is no longer a second product control.
    songLevel: FIXED_SONG_LEVEL,
  }));
}

function updateSingerControls() {
  micGain.disabled = !publisherActive;
  // Compatibility only: Song is a fixed server-owned reference, never an
  // interactive singer control even while this participant owns the Mic.
  songLevel.disabled = true;
  vocalFineTune.disabled = !publisherActive;
  renderGainAdvice();
  updateCalibrateButton();
}

/**
 * Calibration runs itself, but the singer is the one who can hear that it got
 * it wrong, and they are not at the machine the other button is on.
 */
function updateCalibrateButton() {
  const collecting = latestCalibration?.state === 'collecting';
  const probeActive = latestCalibration?.probeActive === true;
  calibrateButton.disabled = !publisherActive
    || roomSongAvailable !== true
    || roomCanStartCalibration !== true;

  if (roomSongAvailable === false) {
    calibrateStatus.textContent = 'No song to align.';
    return;
  }

  if (roomSongAvailable === null) {
    calibrateStatus.textContent = 'Waiting for room state.';
    return;
  }

  if (!liveMixActive) {
    calibrateStatus.textContent = t('adjust.calibration.auto');
    return;
  }

  if (probeActive) {
    const phase = String(latestCalibration?.probePhase ?? '');
    const attempts = latestCalibration?.probeAttempts ?? {};
    const max = Number(latestCalibration?.probeMaxAttempts) || 1;
    const target = phase.startsWith('backing') ? 'Song path' : 'Phone mic';
    const attempt = Number(phase.startsWith('backing') ? attempts.backing : attempts.mic) || 1;
    calibrateStatus.textContent = `Calibrating · ${target} ${Math.min(attempt, max)}/${max}`;
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
      ? t('adjust.calibration.rounds', { agreed: Number(latestCalibration.windowsAgreed) || 0, need })
      : '';
    const provisionalNote = latestCalibration.provisional
      ? t('adjust.calibration.provisional', { lag: signed(latestCalibration.micLagMs, ' ms') })
      : '';
    calibrateStatus.textContent = t('adjust.calibration.collecting', { progress, rounds, provisional: provisionalNote });
    return;
  }

  if (latestCalibration?.state === 'complete') {
    const stale = latestCalibration.calibrationStale ? t('adjust.calibration.stale') : '';
    calibrateStatus.textContent = t('adjust.calibration.complete', { lag: signed(latestCalibration.micLagMs, ' ms'), stale });
    return;
  }

  if (latestCalibration?.state === 'failed') {
    calibrateStatus.textContent = latestCalibration.probeError
      ? t('adjust.calibration.failed', { error: latestCalibration.probeError })
      : latestCalibration.automatic
        ? t('adjust.calibration.autoRetry')
        : t('adjust.calibration.failed', { error: latestCalibration.error ?? t('adjust.calibration.noSignal') });
    return;
  }

  calibrateStatus.textContent = t('adjust.calibration.fallback');
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

function connectSocket() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl());
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('open', () => {
      sendParticipantAuthentication(ws);
      resolve(ws);
    }, { once: true });
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
async function playCalibrationProbe(requestId, leadMs) {
  const context = audioContext;
  if (
    !context
    || !publisherActive
    || document.visibilityState === 'hidden'
    || activeCalibrationProbeRequestId !== requestId
  ) return;

  try {
    // Mobile Safari may leave resume() pending while a page is suspended. The
    // server can retire this request meanwhile, so every continuation has to
    // re-prove request ownership before it is allowed to create audible nodes.
    await context.resume();
    if (activeCalibrationProbeRequestId !== requestId) return;
    if (
      !publisherActive
      || audioContext !== context
      || document.visibilityState === 'hidden'
      || context.state !== 'running'
    ) {
      throw new Error(`Phone probe AudioContext is ${context.state}.`);
    }

    const startTime = context.currentTime + leadMs / 1000;
    for (const note of PROBE_NOTES) {
      const at = startTime + note.offsetMs / 1000;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = note.frequencyHz;
      // A slightly softened attack avoids a sharp test-beep edge. The decay is
      // close to the reference envelope used by the server's correlation.
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(note.gain, at + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + PROBE_NOTE_SECONDS);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(at);
      oscillator.stop(at + PROBE_NOTE_SECONDS);
    }

    // Scheduling the nodes is the irreversible side effect. Retire the local
    // request before acknowledging it so a later status/retry cannot revive the
    // same identity on this page.
    if (activeCalibrationProbeRequestId !== requestId) return;
    activeCalibrationProbeRequestId = null;
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
  } catch (error) {
    console.warn('phone calibration probe failed', error);
    if (activeCalibrationProbeRequestId !== requestId) return;
    activeCalibrationProbeRequestId = null;
    if (socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({
      type: 'calibration-probe-failed',
      target: 'mic',
      requestId,
      generation: captureGeneration >>> 0,
      reason: error instanceof Error ? error.message : String(error),
    }));
  }
}

function dispatchRelayEvent(type, detail = {}) {
  window.dispatchEvent(new CustomEvent(type, { detail }));
}

function handleServerMessage(message, sessionEpoch = publisherSessionEpoch) {
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

  if (message.type === 'calibration-command-rejected') {
    calibrateStatus.textContent = message.reason === 'take-active'
      ? 'Finish the current Take before calibrating.'
      : `Calibration unavailable: ${message.reason ?? 'unknown reason'}`;
    return;
  }

  if (message.type === 'mic-busy') {
    const owner = message.owner ?? null;
    setStatus('Microphone is in use', owner ? `${owner.nickname} has the mic.` : 'Another participant has the mic.');
    dispatchRelayEvent('relay-mic-busy', { owner });
    stop(false, { releaseMic: false })
      .then((stoppedEpoch) => {
        if (publisherSessionEpoch !== stoppedEpoch) return;
        dispatchRelayEvent('relay-microphone-ended', { reason: 'busy' });
      })
      .catch(console.error);
    return;
  }

  if (message.type === 'mic-takeover-rejected') {
    const owner = message.owner ?? null;
    setStatus('Takeover changed', owner ? `${owner.nickname} has the mic now.` : 'The mic state changed.');
    dispatchRelayEvent('relay-mic-takeover-rejected', { owner, reason: message.reason });
    stop(false, { releaseMic: false })
      .then((stoppedEpoch) => {
        if (publisherSessionEpoch !== stoppedEpoch) return;
        dispatchRelayEvent('relay-microphone-ended', { reason: 'takeover-rejected' });
      })
      .catch(console.error);
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

  if (
    message.type === 'registered'
    && message.role === 'publisher'
    && isCurrentPublisherSession(sessionEpoch)
  ) {
    pendingPublisherTakeoverOwnerId = null;
    void audioTransport.prefer(message.mediaTransport ?? null).then((preferred) => {
      if (!isCurrentPublisherSession(sessionEpoch)) return;
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
    const nextFineTune = Number(message.vocalFineTuneMs);
    if (Number.isFinite(nextFineTune) && !sliderIsBusy(vocalFineTune)) {
      vocalFineTune.value = String(nextFineTune);
      updateVocalFineTuneLabel();
    }
    updateCalibrateButton();
    return;
  }

  if (message.type === 'mix-settings') {
    if (!sliderIsBusy(micGain)) micGain.value = String(message.micGainDb ?? 24);
    songLevel.value = String(FIXED_SONG_LEVEL);
    updateMixLabels();
    return;
  }

  if (message.type === 'timing-calibration-status') {
    latestCalibration = message;
    if (
      activeCalibrationProbeRequestId !== null
      && (message.probeActive !== true || message.probePhase !== 'mic-requested')
    ) {
      activeCalibrationProbeRequestId = null;
    }
    updateCalibrateButton();
    return;
  }

  if (message.type === 'play-calibration-probe') {
    // Backing requests are broadcast because the robot source page has no PCM
    // publisher role. The phone must ignore that leg or its faster reply can
    // be mistaken for the robot probe that is still waiting to play.
    if (message.target === undefined || message.target === 'mic') {
      const requestId = Number(message.requestId);
      if (!Number.isSafeInteger(requestId) || requestId < 0) return;
      activeCalibrationProbeRequestId = requestId;
      void playCalibrationProbe(requestId, Number(message.leadMs) || 200);
    }
    return;
  }

  if (message.type === 'mix-health') {
    latestMixHealth = message;
    // Mix health can update the gain recommendation, but the meter itself is
    // intentionally driven only by local capture evidence.
    renderGainAdvice();
    return;
  }
}

function canKeepPublishing() {
  return publisherActive && Boolean(mediaStream) && Boolean(audioContext);
}

function isCurrentPublisherSession(sessionEpoch) {
  return publisherSessionEpoch === sessionEpoch && canKeepPublishing();
}

/**
 * Asks the capture context to start again, and never waits on the answer.
 *
 * Safari suspends this context when the phone is backgrounded and reports
 * `interrupted` as well as `suspended` - the old check saw only the latter, so
 * the commonest case was skipped entirely. Its `resume()` can also be accepted
 * and then never settle, which is why nothing may await it: the singer came
 * back to a page still saying they were live while no audio was leaving the
 * phone, and the only way out was releasing and re-taking the microphone.
 */
function resumePublisherAudioContext() {
  if (!publisherActive || !audioContext) return;
  if (!shouldRequestAudioResume(audioContext.state)) return;
  try {
    const pending = audioContext.resume();
    if (pending && typeof pending.catch === 'function') {
      pending.catch((error) => console.warn('Microphone AudioContext resume failed', error));
    }
  } catch (error) {
    console.warn('Microphone AudioContext resume failed', error);
  }
}

function recoverPublisherAudio() {
  if (!publisherActive) return;
  resumePublisherAudioContext();
}

function schedulePublisherReconnect(sessionEpoch = publisherSessionEpoch) {
  if (!isCurrentPublisherSession(sessionEpoch)) return;
  clearSocketReconnect();
  const timer = setTimeout(() => {
    if (socketReconnectTimer !== timer) return;
    socketReconnectTimer = null;
    if (!isCurrentPublisherSession(sessionEpoch)) return;
    connectPublisherSocket(sessionEpoch).catch(() => {
      if (!isCurrentPublisherSession(sessionEpoch)) return;
      setStatus('Reconnecting microphone…', 'Relay is still unavailable; retrying automatically.');
      schedulePublisherReconnect(sessionEpoch);
    });
  }, SOCKET_RECONNECT_MS);
  socketReconnectTimer = timer;
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

async function connectPublisherSocket(sessionEpoch = publisherSessionEpoch) {
  if (!isCurrentPublisherSession(sessionEpoch)) return;
  clearSocketReconnect();

  const ws = await connectSocket();
  if (!isCurrentPublisherSession(sessionEpoch)) {
    ws.close();
    return;
  }

  adoptSocket(ws);

  const registration = {
    type: 'register',
    role: 'publisher',
    sampleRate: audioContext.sampleRate,
    captureGeneration: captureGeneration >>> 0,
    initialSequence: capturePacketSequence >>> 0,
    audioPacketVersion: AUDIO_PACKET_VERSION,
  };
  if (pendingPublisherTakeoverOwnerId) {
    registration.takeoverExpectedOwnerId = pendingPublisherTakeoverOwnerId;
  }
  ws.send(JSON.stringify(registration));
  audioTransport.bind(ws);
  publisherControlConnections += 1;

  ws.addEventListener('message', (event) => {
    if (
      socket !== ws
      || !isCurrentPublisherSession(sessionEpoch)
      || typeof event.data !== 'string'
    ) return;
    handleServerMessage(JSON.parse(event.data), sessionEpoch);
  });

  ws.addEventListener('close', () => {
    if (socket !== ws) return;
    activeCalibrationProbeRequestId = null;
    audioTransport.unbind(ws);
    socket = null;
    if (!isCurrentPublisherSession(sessionEpoch)) return;
    setStatus('Reconnecting microphone…', 'Relay connection closed; microphone capture stays active.');
    schedulePublisherReconnect(sessionEpoch);
  });

  ws.addEventListener('error', () => {
    try {
      ws.close();
    } catch {}
  });
}

async function stop(setIdle = true, { releaseMic = true } = {}) {
  // Revoke this session before any asynchronous close can yield. Everything
  // after the first await is allowed to touch only captured old resources.
  const stoppedEpoch = ++publisherSessionEpoch;
  micStartup.cancel();
  publisherStarting = false;
  activeCalibrationProbeRequestId = null;
  clearSocketReconnect();
  stopAudioUplinkHealthReporting();

  const closingSocket = socket;
  const closingStream = mediaStream;
  const closingNode = activeNode;
  const closingContext = audioContext;
  const wasPublisherActive = publisherActive;

  socket = null;
  mediaStream = null;
  activeNode = null;
  audioContext = null;

  const shouldReleaseMic = releaseMic && wasPublisherActive;
  if (shouldReleaseMic && closingSocket?.readyState === WebSocket.OPEN) {
    try {
      closingSocket.send(JSON.stringify({ type: 'release-mic' }));
    } catch {}
  }

  if (wasPublisherActive) audioTransport.close();
  pendingPublisherTakeoverOwnerId = null;
  if (closingSocket) {
    try {
      closingSocket.close();
    } catch {}
  }
  if (closingStream) closingStream.getTracks().forEach((track) => track.stop());
  if (closingNode) {
    try {
      closingNode.disconnect();
    } catch {}
  }
  setPublisherActive(false);

  liveMixActive = false;
  latestMixHealth = null;
  latestLocalMicLevel = null;
  dispatchRelayEvent('relay-local-mic-level', {
    active: false,
    peakDbfs: null,
    rmsDbfs: null,
    spectrumBands: null,
  });
  uplinkDroppedSamples = 0;
  uplinkDroppedSamplesByReason = { disconnected: 0, congested: 0, packetTooLarge: 0 };
  captureInputGapSamples = 0;
  captureInputMuted = false;
  publisherControlConnections = 0;
  publisherButton.disabled = false;
  updateSingerControls();
  if (setIdle) setStatus('Idle', 'Take the mic when you are ready.');

  if (closingContext) {
    try {
      await closingContext.close();
    } catch {}
  }
  return stoppedEpoch;
}

async function startPublisher(takeoverExpectedOwnerId = null) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Microphone capture is unavailable. On a phone, open Relay through HTTPS.');
  }

  const startup = micStartup.begin();
  publisherStarting = true;
  publisherButton.disabled = true;
  updateSingerControls();
  pendingPublisherTakeoverOwnerId = takeoverExpectedOwnerId;
  setStatus('Starting microphone…');

  let preparedStream = null;
  let preparedContext = null;
  try {
    // Browser permission promises are not abortable on every supported phone.
    // The gate gives the UI a deadline and stops a stream that resolves after
    // this attempt was cancelled or superseded.
    preparedStream = await micStartup.wait(
      startup,
      navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: false,
      }),
      {
        stage: 'waiting for microphone permission',
        dispose: (stream) => stream.getTracks().forEach((track) => track.stop()),
      },
    );

    preparedContext = new AudioContext({ latencyHint: 'interactive' });
    const captureContext = preparedContext;
    captureContext.addEventListener('statechange', () => {
      if (!publisherActive || audioContext !== captureContext) return;
      resumePublisherAudioContext();
    });
    await micStartup.wait(
      startup,
      captureContext.audioWorklet.addModule('/capture-worklet.js'),
      { stage: 'loading the microphone audio processor' },
    );
    await micStartup.wait(
      startup,
      captureContext.resume(),
      { stage: 'starting microphone audio' },
    );
    if (!micStartup.isCurrent(startup)) throw new MicStartupCancelledError();

    mediaStream = preparedStream;
    preparedStream = null;
    audioContext = preparedContext;
    preparedContext = null;
    const sessionEpoch = ++publisherSessionEpoch;
    const captureStream = mediaStream;
    setPublisherActive(true);
    publisherStarting = false;
    micStartup.complete(startup);

  // A new capture session. Reconnecting the websocket does not bump this: the
  // capture keeps running and its sample cursor stays continuous, so the server
  // can place the reconnected frames on the timeline they already belonged to.
  captureGeneration += 1;
  captureSampleCursor = 0;
  capturePacketSequence = 0;
  captureInputGapSamples = 0;
  captureInputMuted = false;
  latestMixHealth = null;
  latestLocalMicLevel = null;
  uplinkDroppedSamples = 0;
  uplinkDroppedSamplesByReason = { disconnected: 0, congested: 0, packetTooLarge: 0 };
  publisherControlConnections = 0;
  audioTransport.resetStats();
  startAudioUplinkHealthReporting();

  const captureIsCurrent = () => isCurrentPublisherSession(sessionEpoch)
    && mediaStream === captureStream
    && audioContext === captureContext;
  const [track] = captureStream.getAudioTracks();
  captureInputMuted = track?.muted === true;
  track?.addEventListener('mute', () => {
    if (!captureIsCurrent()) return;
    captureInputMuted = true;
    sendAudioUplinkHealth();
    setStatus('Microphone interrupted', 'The phone muted the microphone input; trying to recover it.');
    resumePublisherAudioContext();
  });
  track?.addEventListener('unmute', () => {
    if (!captureIsCurrent()) return;
    captureInputMuted = false;
    sendAudioUplinkHealth();
    setStatus('Microphone is live', 'Microphone input recovered.');
    resumePublisherAudioContext();
  });
  track?.addEventListener('ended', () => {
    if (!captureIsCurrent()) return;
    stop(false, { releaseMic: true })
      .then((stoppedEpoch) => {
        if (publisherSessionEpoch !== stoppedEpoch) return;
        dispatchRelayEvent('relay-microphone-ended', { reason: 'input-ended' });
        setStatus('Microphone stopped', 'The audio input ended. Press Microphone again to restart it.');
      })
      .catch(console.error);
  });

  const source = captureContext.createMediaStreamSource(captureStream);
  const capture = new AudioWorkletNode(captureContext, 'capture-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  const silent = captureContext.createGain();
  silent.gain.value = 0;

  capture.port.onmessage = (event) => {
    // MessagePort delivery is asynchronous. A chunk queued by an old worklet
    // must never be reframed with a replacement session's generation/cursor.
    if (!captureIsCurrent()) return;
    if (!(event.data instanceof ArrayBuffer)) {
      if (event.data?.type === 'input-level') {
        const peakDbfs = Number(event.data.peakDbfs);
        const rmsDbfs = Number(event.data.rmsDbfs);
        const rawSpectrumBands = Array.isArray(event.data.spectrumBands)
          ? event.data.spectrumBands.slice(0, 5).map(Number)
          : [];
        const spectrumBands = rawSpectrumBands.length === 5 && rawSpectrumBands.every(Number.isFinite)
          ? rawSpectrumBands
          : null;
        if (Number.isFinite(peakDbfs) && Number.isFinite(rmsDbfs)) {
          latestLocalMicLevel = { peakDbfs, rmsDbfs, spectrumBands };
          dispatchRelayEvent('relay-local-mic-level', {
            active: true,
            peakDbfs,
            rmsDbfs,
            spectrumBands,
          });
          renderGainAdvice();
        }
        return;
      }
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

  source.connect(capture).connect(silent).connect(captureContext.destination);
  activeNode = capture;

  publisherButton.disabled = true;
  updateSingerControls();
  setStatus('Connecting microphone…', `${captureContext.sampleRate} Hz capture is active; connecting to Relay.`);

    try {
      await connectPublisherSocket(sessionEpoch);
    } catch {
      if (!isCurrentPublisherSession(sessionEpoch)) return;
      setStatus('Reconnecting microphone…', 'Initial Relay connection failed; retrying automatically.');
      schedulePublisherReconnect(sessionEpoch);
    }
  } finally {
    if (preparedStream) preparedStream.getTracks().forEach((track) => track.stop());
    if (preparedContext) {
      try {
        await preparedContext.close();
      } catch {}
    }
  }
}

async function requestPublisherStart(takeoverExpectedOwnerId = null) {
  if (publisherStartRequest) return publisherStartRequest;

  const request = (async () => {
    try {
      await stop(false, { releaseMic: true });
      await startPublisher(takeoverExpectedOwnerId);
    } catch (error) {
      if (error?.code === 'mic-startup-cancelled') return;
      console.error(error);
      const message = error instanceof Error ? error.message : String(error);
      setStatus('Could not start microphone', message);
      dispatchRelayEvent('relay-microphone-start-failed', {
        message,
        takeoverExpectedOwnerId,
      });
      await stop(false, { releaseMic: false });
    }
  })();

  publisherStartRequest = request;
  try {
    await request;
  } finally {
    if (publisherStartRequest === request) publisherStartRequest = null;
  }
}

window.addEventListener('relay-product-status', (event) => {
  const videoId = event.detail?.room?.song?.videoId;
  roomSongAvailable = typeof videoId === 'string' && videoId.length > 0;
  roomCanStartCalibration = event.detail?.actions?.canStartCalibration === true;
  updateCalibrateButton();
});

publisherButton.addEventListener('click', () => {
  requestPublisherStart().catch(console.error);
});

window.addEventListener('relay-request-microphone', (event) => {
  const expectedOwnerId = typeof event.detail?.takeoverExpectedOwnerId === 'string'
    ? event.detail.takeoverExpectedOwnerId
    : null;
  requestPublisherStart(expectedOwnerId).catch(console.error);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    activeCalibrationProbeRequestId = null;
    return;
  }
  recoverPublisherAudio();
});
window.addEventListener('pageshow', recoverPublisherAudio);

window.addEventListener('relay-release-microphone', () => {
  if (!publisherActive) return;
  stop(false, { releaseMic: true })
    .then((stoppedEpoch) => {
      if (publisherSessionEpoch !== stoppedEpoch) return;
      dispatchRelayEvent('relay-microphone-ended', { reason: 'released' });
      setStatus('Microphone released', 'This phone is no longer using the microphone.');
    })
    .catch(console.error);
});

for (const slider of [micGain, songLevel]) {
  slider.addEventListener('input', () => {
    markSliderTouched(slider);
    sendMixSettings();
  });
  slider.addEventListener('change', () => markSliderTouched(slider));
}

vocalFineTune.addEventListener('input', () => {
  markSliderTouched(vocalFineTune);
  sendVocalFineTune();
});
vocalFineTune.addEventListener('change', () => markSliderTouched(vocalFineTune));

useMicGainSuggestion.addEventListener('click', () => {
  const recommended = Number(latestMixHealth?.recommendedMicGainDb);
  if (!publisherActive || !Number.isFinite(recommended)) return;
  micGain.value = String(Math.max(0, Math.min(MAX_RECOMMENDED_MIC_GAIN_DB, Math.round(recommended))));
  markSliderTouched(micGain);
  sendMixSettings();
});

window.addEventListener('relay-locale-changed', () => {
  renderGainAdvice();
  updateCalibrateButton();
});

calibrateButton.addEventListener('click', () => {
  if (socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: 'start-timing-calibration' }));
});

updateMixLabels();
updateCalibrateButton();
updateSingerControls();
setStatus('Idle', 'Take the mic when you are ready.');
