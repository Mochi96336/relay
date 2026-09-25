import { authorityState } from './authority-freshness.js';
import { PublisherCommandLiveness } from './publisher-command-liveness.js';
import { sendParticipantAuthentication } from './participant-auth.js';
await window.relayIdentityReady;
import { PreferredAudioTransport } from './audio-transport.js';
import { DEFAULT_CAPTURE_DISPATCH_BACKLOG_MS, classifyCaptureDispatch } from './capture-dispatch.js';
import { shouldRequestAudioResume } from './audio-context-recovery.js';
import { MicCaptureRecoveryWatchdog } from './mic-capture-recovery.js';
import { MicStartupCancelledError, MicStartupGate } from './mic-startup.js';
import {
  captureClippingSnapshot,
  captureInputClippingDetected,
  captureRecentInputClippingDetected,
  captureLevelSnapshot,
  captureVoiceProcessingActive,
  enforceUnprocessedCapture,
  readCaptureSettings,
} from './capture-observability.js';
import { MicLifecycleTransaction } from './mic-lifecycle-transaction.js';
const t = (key, vars) => window.relayI18n?.t(key, vars) ?? key;
import { splitPcmForPacketLimit } from './audio-packetizer.js';
import { createReconnectBackoff } from './reconnect-backoff.js';

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

// Mic audio on a WebSocket-only page rides this socket: reconnect fast, back
// off only while it keeps failing. See reconnect-backoff.js.
const publisherReconnectBackoff = createReconnectBackoff();
const SLIDER_HOLD_MS = 2000;
const AUDIO_UPLINK_HEALTH_INTERVAL_MS = 1000;
const MIC_CAPTURE_WATCHDOG_INTERVAL_MS = 250;
const MAX_MIC_GAIN_DB = 40;
const MAX_RECOMMENDED_MIC_GAIN_DB = 36;
const FIXED_SONG_LEVEL = 100;

let socket = null;
let socketReconnectTimer = null;
let audioContext = null;
let mediaStream = null;
let activeNode = null;
let activeCaptureGraph = null;
let captureGraphEpoch = 0;
let captureGraphRebuildPromise = null;
let captureWatchdogTimer = null;
let publisherActive = false;
let publisherAuthorityFresh = false;
let publisherMixSettingsFresh = false;
let publisherSourceStatusFresh = false;
let publisherStarting = false;
let publisherStartRequest = null;
const micStartup = new MicStartupGate();
const micCaptureRecovery = new MicCaptureRecoveryWatchdog();
const micLifecycle = new MicLifecycleTransaction();
const publisherCommandLiveness = new PublisherCommandLiveness();
let publishedPublisherCommandChannelFresh = false;
let liveMixActive = false;
let latestMixHealth = null;
let latestLocalMicLevel = null;
let captureAppliedSettings = null;
let latestCalibration = null;
let roomSongAvailable = null;
let roomCanStartCalibration = null;
let pendingPublisherTakeoverOwnerId = null;
let activeCalibrationProbeRequestId = null;
let activeCalibrationProbePlayback = null;
let publisherSessionEpoch = 0;
let lastKnownControlSnapshot = {
  micGainDb: Number(micGain.value) || 24,
  vocalFineTuneMs: Number(vocalFineTune.value) || 0,
};

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

  const clipping = captureClippingSnapshot(latestLocalMicLevel);
  if (captureInputClippingDetected(clipping)) {
    micGainRecommendationMarker.hidden = true;
    micGainRecommendation.textContent = t('adjust.inputClipping');
    micGainAdvice.textContent = t('adjust.inputClippingHelp');
    useMicGainSuggestion.hidden = true;
    return;
  }

  if (captureVoiceProcessingActive(captureAppliedSettings)) {
    micGainRecommendationMarker.hidden = true;
    micGainRecommendation.textContent = t('adjust.processingActive');
    micGainAdvice.textContent = t('adjust.processingActiveHelp');
    useMicGainSuggestion.hidden = true;
    return;
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

  const canApply = publisherCommandAuthority().actionable && Math.abs(off) > 3;
  useMicGainSuggestion.hidden = !canApply;
  useMicGainSuggestion.disabled = !publisherCommandAuthority().actionable;
  useMicGainSuggestion.textContent = t('adjust.useGain', { gain: suggested });
}
let uplinkDroppedSamples = 0;
let uplinkDroppedSamplesByReason = { disconnected: 0, congested: 0, packetTooLarge: 0, captureBacklog: 0 };
let latestCaptureDispatchLagMs = null;
let maxCaptureDispatchLagMs = null;
let captureDispatchBacklogActive = false;
let captureInputGapSamples = 0;
/**
 * Null means the active worklet does not expose interval clipping evidence
 * (rollout-compatible legacy). Once observed, this is the OR of clipped 20 ms
 * windows since the last server-acknowledged uplink-health report.
 */
let captureInputClippingSinceHealth = null;
let captureInputClippingRevision = 0;
const pendingCaptureClippingHealth = new Map();

function resetPublisherHealthRequestCorrelation() {
  // Once command-channel authority resets, no ACK from an older socket can be
  // accepted by handleServerMessage(). Keep the interval evidence itself, but
  // discard request ids that can no longer settle it so repeated failed
  // reconnect cycles cannot grow this map indefinitely.
  publisherCommandLiveness.reset();
  pendingCaptureClippingHealth.clear();
}

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
let captureGeneration = Date.now() >>> 0;
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
  // The capture graph can emit before Relay returns its registered/media offer.
  // Keep those samples as timeline holes rather than racing one startup packet
  // onto WebSocket before WebTransport preference has a chance to resolve.
  holdMediaUntilPreference: true,
  // Half the server's default 3 s first-frame deadline: enough for normal WT
  // setup, but bounded so a stuck handshake still reaches WS fallback in time.
  initialPreferenceHoldMs: 1_500,
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
  else if (reason === 'capture-backlog') uplinkDroppedSamplesByReason.captureBacklog += sampleCount;
  if (reason === 'disconnected') return;

  const now = performance.now();
  if (now - lastUplinkWarningAt <= 2000) return;
  lastUplinkWarningAt = now;
  const sampleRate = audioContext?.sampleRate ?? 48000;
  const droppedMs = Math.round((uplinkDroppedSamples * 1000) / sampleRate);
  const title = reason === 'packet-too-large'
    ? 'Microphone datagram budget changed'
    : reason === 'capture-backlog'
      ? 'Microphone capture caught up to live audio'
      : 'Microphone uplink congested';
  setStatus(
    title,
    `Dropped about ${droppedMs} ms of microphone audio. ` +
    'The sample timeline keeps the hole in the right place instead of pulling later audio earlier.',
  );
}

function captureClippingHealthSnapshot() {
  const clipping = captureClippingSnapshot(latestLocalMicLevel);
  if (!clipping) return null;
  const {
    windowMaxConsecutiveRailSamples: _windowMaxConsecutiveRailSamples,
    ...lifetime
  } = clipping;
  return {
    ...lifetime,
    ...(captureInputClippingSinceHealth === null
      ? {}
      : { recentDetected: captureInputClippingSinceHealth }),
  };
}

function settleCaptureClippingHealth(healthRequestId) {
  const accepted = pendingCaptureClippingHealth.get(healthRequestId);
  if (!accepted) return false;

  // Mirror PublisherCommandLiveness supersession: once this request is
  // acknowledged, any older clipping snapshot can never become authoritative.
  for (const [requestId, pending] of pendingCaptureClippingHealth) {
    if (pending.sentAtMs <= accepted.sentAtMs) pendingCaptureClippingHealth.delete(requestId);
  }

  // Do not let an older ACK erase a clipped window that occurred after that
  // request was sent.
  if (
    captureInputClippingSinceHealth !== null
    && accepted.revision === captureInputClippingRevision
  ) {
    captureInputClippingSinceHealth = false;
  }
  return true;
}

function audioUplinkHealthPayload(healthRequestId) {
  return {
    type: 'audio-uplink-health',
    version: 1,
    captureGeneration: captureGeneration >>> 0,
    healthRequestId,
    capturedSamples: captureSampleCursor,
    inputGapSamples: captureInputGapSamples,
    inputGapActive: micCaptureRecovery.status().inputGapActive,
    inputMuted: captureInputMuted,
    // Browser/worklet observations only; none of these fields is a calibration gate.
    capture: captureAppliedSettings,
    captureLevel: captureLevelSnapshot(latestLocalMicLevel),
    captureClipping: captureClippingHealthSnapshot(),
    captureDispatch: latestCaptureDispatchLagMs === null ? null : {
      lagMs: latestCaptureDispatchLagMs,
      maxLagMs: maxCaptureDispatchLagMs,
      backlogMs: DEFAULT_CAPTURE_DISPATCH_BACKLOG_MS,
      backlogActive: captureDispatchBacklogActive,
    },
    droppedSamples: { total: uplinkDroppedSamples, ...uplinkDroppedSamplesByReason },
    controlReconnects: Math.max(0, publisherControlConnections - 1),
    transport: audioTransport.stats(),
  };
}

function sendAudioUplinkHealth() {
  maintainPublisherCommandChannel();
  if (!publisherActive || socket?.readyState !== WebSocket.OPEN) return false;
  const sentAtMs = performance.now();
  const healthRequestId = publisherCommandLiveness.beginHealthRequest(sentAtMs);
  if (healthRequestId === null) return false;
  const result = audioTransport.sendControlJson(audioUplinkHealthPayload(healthRequestId));
  if (!result.sent) {
    publisherCommandLiveness.cancelHealthRequest(healthRequestId);
  } else {
    // Keep interval evidence until the server ACK proves this exact health
    // report was accepted. The revision prevents a late ACK from clearing
    // clipping that happened after this request left the page.
    pendingCaptureClippingHealth.set(healthRequestId, {
      revision: captureInputClippingRevision,
      sentAtMs,
    });
  }
  return result.sent;
}

function startAudioUplinkHealthReporting() {
  if (audioUplinkHealthTimer !== null) clearInterval(audioUplinkHealthTimer);
  audioUplinkHealthTimer = setInterval(sendAudioUplinkHealth, AUDIO_UPLINK_HEALTH_INTERVAL_MS);
}

function stopAudioUplinkHealthReporting() {
  if (audioUplinkHealthTimer !== null) clearInterval(audioUplinkHealthTimer);
  audioUplinkHealthTimer = null;
}

function captureSnapshot() {
  return {
    nowMs: performance.now(),
    visible: document.visibilityState !== 'hidden',
    contextState: audioContext?.state ?? 'closed',
    contextTime: audioContext?.currentTime ?? 0,
    sampleCursor: captureSampleCursor,
    inputMuted: captureInputMuted,
  };
}

function stopCaptureWatchdog() {
  if (captureWatchdogTimer !== null) clearInterval(captureWatchdogTimer);
  captureWatchdogTimer = null;
}

function startCaptureWatchdog(
  sessionEpoch = publisherSessionEpoch,
  expectedGeneration = captureGeneration >>> 0,
) {
  stopCaptureWatchdog();
  captureWatchdogTimer = setInterval(() => {
    if (!isCurrentPublisherCapture(sessionEpoch, expectedGeneration)) return;
    const decision = micCaptureRecovery.observe(captureSnapshot());
    if (decision.resume) resumePublisherAudioContext();
    if (decision.rebuild) void rebuildPublisherCaptureGraph('pcm-stall');
  }, MIC_CAPTURE_WATCHDOG_INTERVAL_MS);
}

function advanceCaptureGeneration(reason) {
  // Calibration probe playback is capture-scoped. Retire both a pending
  // AudioContext.resume() continuation and nodes already scheduled into the
  // future before changing the capture-clock identity.
  activeCalibrationProbeRequestId = null;
  retireCalibrationProbePlayback();
  captureGeneration = ((captureGeneration >>> 0) + 1) >>> 0;
  captureSampleCursor = 0;
  capturePacketSequence = 0;
  captureInputGapSamples = 0;
  captureInputClippingSinceHealth = null;
  captureInputClippingRevision = 0;
  pendingCaptureClippingHealth.clear();
  captureInputMuted = mediaStream?.getAudioTracks?.()[0]?.muted === true;
  latestLocalMicLevel = null;
  uplinkDroppedSamples = 0;
  uplinkDroppedSamplesByReason = { disconnected: 0, congested: 0, packetTooLarge: 0, captureBacklog: 0 };
  latestCaptureDispatchLagMs = null;
  maxCaptureDispatchLagMs = null;
  captureDispatchBacklogActive = false;
  audioTransport.resetStats();
  dispatchRelayEvent('relay-microphone-capture-generation', {
    captureGeneration: captureGeneration >>> 0,
    reason,
  });
  return captureGeneration >>> 0;
}

function disposeCaptureGraph(graph) {
  if (!graph) return;
  try {
    graph.capture.port.onmessage = null;
  } catch {}
  try {
    if (graph.deviceChangeListener) {
      navigator.mediaDevices?.removeEventListener?.('devicechange', graph.deviceChangeListener);
    }
  } catch {}
  graph.deviceChangeListener = null;
  graph.deviceChangeCheckPending = false;
  try {
    if (graph.processorErrorListener) {
      graph.capture?.removeEventListener?.('processorerror', graph.processorErrorListener);
    }
  } catch {}
  graph.processorErrorListener = null;
  try {
    graph.visualAnalysisWorker?.terminate();
  } catch {}
  graph.visualAnalysisWorker = null;
  for (const node of [graph.source, graph.capture, graph.silent]) {
    try {
      node?.disconnect();
    } catch {}
  }
}

function captureGraphIsCurrent(graph) {
  return Boolean(
    graph
    && activeCaptureGraph === graph
    && graph.epoch === captureGraphEpoch
    && isCurrentPublisherSession(graph.sessionEpoch)
    && mediaStream === graph.stream
    && audioContext === graph.context
  );
}

function captureTrackDeviceId(track) {
  try {
    const deviceId = track?.getSettings?.().deviceId;
    return typeof deviceId === 'string' && deviceId.length > 0 ? deviceId : null;
  } catch {
    return null;
  }
}

function rebuildCaptureForInputDeviceChange(graph) {
  if (!captureGraphIsCurrent(graph)) return false;
  const track = graph.stream.getAudioTracks?.()[0] ?? null;
  const currentDeviceId = captureTrackDeviceId(track);
  if (currentDeviceId === null) return false;

  // Some browsers reveal deviceId only after the first post-permission
  // configuration event. Establishing that first known identity is not itself
  // a route change.
  if (graph.inputDeviceId === null) {
    graph.inputDeviceId = currentDeviceId;
    return false;
  }
  if (currentDeviceId === graph.inputDeviceId) return false;

  // The physical input authority changed while the track stayed live. Treat
  // this as a capture-clock boundary: a fresh generation lets the server retire
  // old positioned PCM and invalidate timing calibrated against the old device.
  void rebuildPublisherCaptureGraph('input-device-changed');
  return true;
}

function announceCaptureRecovered() {
  const connected = socket?.readyState === WebSocket.OPEN;
  if (connected) {
    setStatus('Microphone is live', `${audioContext?.sampleRate ?? '--'} Hz mono PCM · fresh capture confirmed`);
  } else {
    setStatus('Microphone capture recovered', 'Fresh PCM resumed; reconnecting the Relay transport.');
  }
  dispatchRelayEvent('relay-microphone-recovered', {
    captureGeneration: captureGeneration >>> 0,
    sampleCursor: captureSampleCursor,
  });
  sendAudioUplinkHealth();
}

function parseMicVisualAnalysis(payload) {
  const rawSpectrumBands = Array.isArray(payload?.spectrumBands)
    ? payload.spectrumBands.slice(0, 5).map(Number)
    : [];
  const spectrumBands = rawSpectrumBands.length === 5 && rawSpectrumBands.every(Number.isFinite)
    ? rawSpectrumBands
    : null;
  const rawF0Hz = payload?.f0Hz;
  const f0Hz = rawF0Hz === null ? null : Number(rawF0Hz);
  const pitchConfidence = Number(payload?.pitchConfidence);
  if (
    spectrumBands === null
    || (f0Hz !== null && !Number.isFinite(f0Hz))
    || !Number.isFinite(pitchConfidence)
    || pitchConfidence < 0
    || pitchConfidence > 1
  ) return null;
  return { spectrumBands, f0Hz, pitchConfidence };
}

function attachMicVisualAnalysisWorker(graph) {
  if (typeof Worker !== 'function') return;
  try {
    const worker = new Worker('/mic-visual-analysis-worker.js', {
      name: 'relay-mic-visual-analysis',
    });
    graph.visualAnalysisWorker = worker;
    worker.onmessage = (event) => {
      if (!captureGraphIsCurrent(graph) || event.data?.type !== 'analysis') return;
      const analysis = parseMicVisualAnalysis(event.data);
      if (analysis) graph.visualAnalysis = analysis;
    };
    worker.onerror = () => {
      if (graph.visualAnalysisWorker !== worker) return;
      try { worker.terminate(); } catch {}
      graph.visualAnalysisWorker = null;
    };
    worker.postMessage({
      type: 'configure',
      sampleRate: graph.context.sampleRate,
    });
  } catch {
    graph.visualAnalysisWorker = null;
  }
}

function submitMicVisualAnalysis(graph, pcm) {
  const worker = graph.visualAnalysisWorker;
  if (!worker) return;
  try {
    // PCM transport owns the original buffer. Visual analysis gets a tiny
    // bounded copy on the page thread, then all FFT/YIN work happens in its own
    // Worker so no visual computation can consume an AudioWorklet deadline.
    const analysisBuffer = pcm.slice(0);
    worker.postMessage({ type: 'pcm', buffer: analysisBuffer }, [analysisBuffer]);
  } catch {
    try { worker.terminate(); } catch {}
    graph.visualAnalysisWorker = null;
  }
}

function handleCaptureWorkletMessage(event, graph) {
  // MessagePort delivery is asynchronous. A chunk queued by an old worklet
  // must never be reframed with a replacement graph's generation/cursor.
  if (!captureGraphIsCurrent(graph)) return;
  const pcmMessage = event.data instanceof ArrayBuffer
    ? { buffer: event.data, capturedAtContextTime: null }
    : event.data?.type === 'pcm' && event.data.buffer instanceof ArrayBuffer
      ? {
          buffer: event.data.buffer,
          capturedAtContextTime: event.data.capturedAtContextTime,
        }
      : null;

  if (!pcmMessage) {
    if (event.data?.type === 'input-level') {
      const peakDbfs = Number(event.data.peakDbfs);
      const rmsDbfs = Number(event.data.rmsDbfs);
      // A cached old worklet still carries real visual analysis in this message.
      // A current worklet carries neutral compatibility fields and the dedicated
      // Worker below replaces them as soon as its first result arrives.
      const analysis = graph.visualAnalysis ?? parseMicVisualAnalysis(event.data);
      if (Number.isFinite(peakDbfs) && Number.isFinite(rmsDbfs) && analysis) {
        const { spectrumBands, f0Hz, pitchConfidence } = analysis;
        const clipping = captureClippingSnapshot(event.data);
        if (clipping?.windowMaxConsecutiveRailSamples !== undefined) {
          if (captureInputClippingSinceHealth === null) captureInputClippingSinceHealth = false;
          if (captureRecentInputClippingDetected(clipping)) {
            captureInputClippingSinceHealth = true;
            captureInputClippingRevision += 1;
          }
        }
        latestLocalMicLevel = {
          peakDbfs,
          rmsDbfs,
          spectrumBands,
          f0Hz,
          pitchConfidence,
          ...(clipping ?? {}),
        };
        dispatchRelayEvent('relay-local-mic-level', {
          active: true,
          captureGeneration: captureGeneration >>> 0,
          peakDbfs,
          rmsDbfs,
          spectrumBands,
          f0Hz,
          pitchConfidence,
          railSamples: clipping?.railSamples ?? null,
          maxConsecutiveRailSamples: clipping?.maxConsecutiveRailSamples ?? null,
          windowMaxConsecutiveRailSamples: clipping?.windowMaxConsecutiveRailSamples ?? null,
        });
        renderGainAdvice();
      }
      return;
    }
    if (event.data?.type === 'input-gap') {
      const digitalSilence = event.data.reason === 'digital-silence';

      // Exact digital zero is strong audibility evidence, but not positive proof
      // that the capture graph is broken: headset/OS noise gates can legitimately
      // render exact zeros while a live track remains healthy. The server-side
      // MicAudibilityMonitor sees the same PCM and can surface Retry Mic if the
      // room stays inaudible. Do not promote this heuristic into automatic
      // generation replacement.
      if (digitalSilence) {
        console.warn(
          'Microphone input gap',
          'rendering exact digital silence',
          event.data.recovered ? '(recovered)' : '(continuing)',
        );
        return;
      }

      const samples = Number(event.data.samples);
      if (Number.isSafeInteger(samples) && samples > 0) captureInputGapSamples += samples;
      const decision = micCaptureRecovery.noteInputGap(captureSnapshot(), {
        recovered: event.data.recovered === true,
      });
      // A missing worklet input channel is positive source-failure authority.
      // Publish both edges immediately so Relay can fail closed and later
      // require PCM beyond the exact recovery cursor before declaring Mic live.
      sendAudioUplinkHealth();
      console.warn(
        'Microphone input gap',
        `${event.data.quanta} quanta padded with silence`,
        event.data.recovered ? '(recovered)' : '(continuing)',
      );
      if (decision.rebuild) void rebuildPublisherCaptureGraph('input-gap');
    }
    return;
  }

  // Capture time advances even when a stale main-thread dispatch is dropped.
  // The next fresh packet therefore exposes the skipped interval as a real
  // firstSampleIndex hole instead of pulling old voice forward in time.
  const pcm = pcmMessage.buffer;
  const chunkFirstSampleIndex = captureSampleCursor;
  captureSampleCursor += pcm.byteLength / 2;

  const dispatch = classifyCaptureDispatch({
    currentContextTimeSeconds: graph.context.currentTime,
    capturedAtContextTimeSeconds: pcmMessage.capturedAtContextTime,
    fallbackCapturedAtContextTimeSeconds:
      graph.captureClockOriginContextTime + (chunkFirstSampleIndex / graph.context.sampleRate),
  });
  if (dispatch.measurable) {
    latestCaptureDispatchLagMs = Math.round(dispatch.lagMs);
    maxCaptureDispatchLagMs = Math.max(
      maxCaptureDispatchLagMs ?? 0,
      latestCaptureDispatchLagMs,
    );
    captureDispatchBacklogActive = dispatch.stale;
  }

  const recovery = micCaptureRecovery.observe(captureSnapshot(), {
    freshPcm: !dispatch.stale && captureInputMuted !== true,
  });
  if (recovery.recovered) announceCaptureRecovered();

  if (dispatch.stale) {
    recordUplinkDrop(pcm.byteLength / 2, 'capture-backlog');
    return;
  }

  submitMicVisualAnalysis(graph, pcm);

  const pending = splitPcmForPacketLimit(
    pcm,
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

    // A packet kept for repair spends its sequence even though it did not go
    // out: numbering the next packet the same would hide the hole from Relay,
    // which then never asks for the audio the transport kept for it.
    if (sendResult.sent || sendResult.retained) {
      capturePacketSequence = (capturePacketSequence + 1) >>> 0;
    }
    if (sendResult.sent) continue;

    if (
      sendResult.reason === 'disconnected'
      || sendResult.reason === 'congested'
      || sendResult.reason === 'packet-too-large'
    ) {
      recordUplinkDrop(segment.pcm.byteLength / 2, sendResult.reason);
    }
  }
}

function installCaptureGraph(sessionEpoch, captureStream, captureContext) {
  const source = captureContext.createMediaStreamSource(captureStream);
  const capture = new AudioWorkletNode(captureContext, 'capture-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  const silent = captureContext.createGain();
  silent.gain.value = 0;
  const graph = {
    epoch: ++captureGraphEpoch,
    sessionEpoch,
    stream: captureStream,
    context: captureContext,
    source,
    capture,
    silent,
    visualAnalysisWorker: null,
    visualAnalysis: null,
    deviceChangeListener: null,
    deviceChangeCheckPending: false,
    processorErrorListener: null,
    inputDeviceId: captureTrackDeviceId(captureStream.getAudioTracks?.()[0] ?? null),
    // Raw PCM from a cached pre-envelope worklet has no per-chunk timestamp.
    // Anchor its positioned sample clock at graph installation so old worklet
    // compatibility cannot bypass the same realtime backlog budget.
    captureClockOriginContextTime: captureContext.currentTime,
  };

  if (typeof capture.addEventListener === 'function') {
    graph.processorErrorListener = () => {
      if (!captureGraphIsCurrent(graph)) return;
      // Per Web Audio, a processorerror leaves this AudioWorkletNode producing
      // silence for the rest of its lifetime. Spend the same one-shot rebuild
      // budget as the generic watchdog so a deterministic worklet bug cannot
      // create an unbounded generation/rebuild loop.
      const decision = micCaptureRecovery.noteProcessorError(captureSnapshot());
      if (decision.rebuild) {
        void rebuildPublisherCaptureGraph('processor-error');
        return;
      }
      if (!decision.exhausted) return;

      // A replacement processor failed again before fresh PCM could re-arm the
      // budget. Stop local capture into the bounded server reconnect grace and
      // require the existing user-gesture Retry Mic path.
      void finishMicrophoneSession('processor-error-repeated', {
        releaseMic: false,
        afterEnded: () => {
          setStatus(
            'Microphone interrupted',
            'The microphone processor failed repeatedly. Retry Mic to reconnect it.',
          );
        },
      }).catch(console.error);
    };
    capture.addEventListener('processorerror', graph.processorErrorListener);
  }

  const mediaDevices = navigator.mediaDevices;
  if (
    typeof mediaDevices?.enumerateDevices === 'function'
    && typeof mediaDevices?.addEventListener === 'function'
  ) {
    graph.deviceChangeListener = () => {
      if (!captureGraphIsCurrent(graph) || graph.deviceChangeCheckPending) return;

      const track = graph.stream.getAudioTracks?.()[0] ?? null;
      // A terminal track has its own ended lifecycle and already enters Mic
      // reconnect grace. Device presence is only extra evidence for a track
      // that still claims to be live.
      if (!track || track.readyState === 'ended') return;

      // A browser can auto-route the same live track from input A to input B.
      // That is a capture replacement, not proof that the Mic is dead.
      if (rebuildCaptureForInputDeviceChange(graph)) return;

      const deviceId = captureTrackDeviceId(track);
      if (deviceId === null) return;

      graph.deviceChangeCheckPending = true;
      Promise.resolve(mediaDevices.enumerateDevices()).then((devices) => {
        if (!captureGraphIsCurrent(graph) || track.readyState === 'ended') return;

        // devicechange may fire before WebKit updates getSettings(). Re-check
        // after enumerateDevices() settles so A→B auto-routing cannot be
        // mistaken for "A disappeared" and torn down.
        if (rebuildCaptureForInputDeviceChange(graph)) return;
        const confirmedDeviceId = captureTrackDeviceId(track);
        if (confirmedDeviceId !== deviceId) return;

        const audioInputs = Array.isArray(devices)
          ? devices.filter((device) => device?.kind === 'audioinput')
          : [];
        // Some constrained browsers can resolve enumerateDevices() with an
        // empty/filtered list instead of rejecting. That is not positive device
        // removal evidence. Prefer a missed recovery over tearing down a live
        // Mic on an ambiguous platform response.
        if (audioInputs.length === 0) return;
        const inputStillPresent = audioInputs.some(
          (device) => device.deviceId === deviceId,
        );
        if (inputStillPresent) return;

        return finishMicrophoneSession('input-device-removed', {
          // A confirmed hardware removal is not a user intent to give up the
          // room Mic. Reuse the same bounded server reconnect grace as track
          // ended / graph-rebuild failure and require a user-gesture Retry Mic
          // to obtain the replacement capture.
          releaseMic: false,
          afterEnded: () => {
            setStatus(
              'Microphone interrupted',
              'The active input device disappeared. Retry Mic to reconnect it.',
            );
          },
        });
      }).catch((error) => {
        // Device enumeration is opportunistic evidence only. Permission or
        // platform errors must never tear down an otherwise live capture.
        console.warn('Microphone device presence check failed', error);
      }).finally(() => {
        graph.deviceChangeCheckPending = false;
      });
    };
    mediaDevices.addEventListener('devicechange', graph.deviceChangeListener);
  }

  capture.port.onmessage = (event) => handleCaptureWorkletMessage(event, graph);
  attachMicVisualAnalysisWorker(graph);
  // New app + new worklet opts into timestamped PCM. Old worklets ignore this
  // message and keep sending raw ArrayBuffer, which this app still accepts.
  // More importantly, a newly deployed worklet defaults to raw PCM until it
  // sees this, so a page whose old app.js stayed open across a deploy remains
  // able to publish audio.
  capture.port.postMessage({ type: 'capture-protocol', pcmEnvelope: true });
  source.connect(capture).connect(silent).connect(captureContext.destination);
  activeCaptureGraph = graph;
  activeNode = capture;
  return graph;
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

function publisherCommandChannelFresh(nowMs = performance.now()) {
  return socket?.readyState === WebSocket.OPEN
    && publisherCommandLiveness.status(nowMs).fresh;
}

function publisherCommandAuthority(serverAllowed = true) {
  return authorityState({
    authorityFresh: publisherAuthorityFresh
      && publisherMixSettingsFresh
      && publisherSourceStatusFresh,
    lastKnownSnapshot: lastKnownControlSnapshot,
    commandChannelFresh: publisherCommandChannelFresh(),
    authorized: publisherActive,
    serverAllowed,
  });
}

function publishPublisherCommandAuthority() {
  const detail = publisherCommandAuthority();
  publishedPublisherCommandChannelFresh = detail.commandChannelFresh;
  window.relayCommandAuthority = detail;
  dispatchRelayEvent('relay-command-authority', detail);
  return detail;
}

function refreshPublisherCommandChannel() {
  const fresh = publisherCommandChannelFresh();
  if (fresh === publishedPublisherCommandChannelFresh) return fresh;
  publishPublisherCommandAuthority();
  updateSingerControls();
  return fresh;
}

function maintainPublisherCommandChannel() {
  const state = publisherCommandLiveness.status(performance.now());
  if (
    state.reconnect
    && publisherActive
    && socket?.readyState === WebSocket.OPEN
  ) {
    publishPublisherCommandAuthority();
    updateSingerControls();
    setStatus(
      'Reconnecting microphone…',
      'Relay control acknowledgement stopped; restarting the control connection.',
    );
    const staleSocket = socket;
    try {
      staleSocket.close(4000, 'publisher command ack stale');
    } catch {
      try { staleSocket.close(); } catch {}
    }
    return false;
  }
  return refreshPublisherCommandChannel();
}

function restoreLastKnownControl(command = null) {
  if (command === null || command === 'set-mix') {
    micGain.value = String(lastKnownControlSnapshot.micGainDb);
    updateMixLabels();
  }
  if (command === null || command === 'set-vocal-fine-tune') {
    vocalFineTune.value = String(lastKnownControlSnapshot.vocalFineTuneMs);
    updateVocalFineTuneLabel();
  }
}

function resetPublisherCommandFreshness() {
  publisherAuthorityFresh = false;
  publisherMixSettingsFresh = false;
  publisherSourceStatusFresh = false;
}

function markPublisherAuthorityStale() {
  resetPublisherCommandFreshness();
  publishPublisherCommandAuthority();
  updateSingerControls();
}

function setPublisherActive(active) {
  publisherActive = Boolean(active);
  if (!publisherActive) resetPublisherCommandFreshness();
  // listen.js / recorder.js consume the legacy role, while Presence consumes
  // the explicit local lifecycle event so Release never depends on a server
  // ownership snapshot arriving first.
  window.relayActiveRole = publisherActive ? 'publisher' : null;
  dispatchRelayEvent('relay-microphone-local-state', { active: publisherActive });
  publishPublisherCommandAuthority();
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
  if (!publisherCommandAuthority().actionable) {
    restoreLastKnownControl('set-vocal-fine-tune');
    return false;
  }
  try {
    const result = audioTransport.sendControlJson({
      type: 'set-vocal-fine-tune',
      valueMs: Number(vocalFineTune.value),
    });
    if (!result.sent) {
      restoreLastKnownControl('set-vocal-fine-tune');
      if (result.reason === 'disconnected') markPublisherAuthorityStale();
      return false;
    }
  } catch {
    restoreLastKnownControl('set-vocal-fine-tune');
    markPublisherAuthorityStale();
    return false;
  }
  updateVocalFineTuneLabel();
  return true;
}

function sendMixSettings() {
  if (!publisherCommandAuthority().actionable) {
    restoreLastKnownControl('set-mix');
    return false;
  }
  try {
    const result = audioTransport.sendControlJson({
      type: 'set-mix',
      micGainDb: Number(micGain.value),
      // Retain the old field on the wire while the server owns its only valid
      // value. It is no longer a second product control.
      songLevel: FIXED_SONG_LEVEL,
    });
    if (!result.sent) {
      restoreLastKnownControl('set-mix');
      if (result.reason === 'disconnected') markPublisherAuthorityStale();
      return false;
    }
  } catch {
    restoreLastKnownControl('set-mix');
    markPublisherAuthorityStale();
    return false;
  }
  updateMixLabels();
  return true;
}

function updateSingerControls() {
  const actionable = publisherCommandAuthority().actionable;
  micGain.disabled = !actionable;
  // Compatibility only: Song is a fixed server-owned reference, never an
  // interactive singer control even while this participant owns the Mic.
  songLevel.disabled = true;
  vocalFineTune.disabled = !actionable;
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
  calibrateButton.disabled = !publisherCommandAuthority(
    roomSongAvailable === true && roomCanStartCalibration === true,
  ).actionable;

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

function retireCalibrationProbePlayback() {
  const playback = activeCalibrationProbePlayback;
  activeCalibrationProbePlayback = null;
  if (!playback) return;
  for (const { oscillator, gain } of playback.nodes) {
    try { oscillator?.disconnect(); } catch {}
    try { gain?.disconnect(); } catch {}
    try { oscillator?.stop(); } catch {}
  }
}

/**
 * Plays the probe out of the phone speaker so the phone's own microphone hears
 * it. The reply says only that it played and for which request - the server
 * derives the timing from its own round trip, because the client's clock is
 * not on the session's timeline and mapping it would be the very thing being
 * measured.
 */
async function playCalibrationProbe(requestId, leadMs) {
  const context = audioContext;
  const sessionEpoch = publisherSessionEpoch;
  const expectedGeneration = captureGeneration >>> 0;
  if (
    !context
    || !isCurrentPublisherCapture(sessionEpoch, expectedGeneration)
    || document.visibilityState === 'hidden'
    || activeCalibrationProbeRequestId !== requestId
  ) return;

  try {
    // Mobile Safari may leave resume() pending while a page is suspended. The
    // server can retire this request meanwhile, so every continuation has to
    // re-prove request and capture ownership before it may create audible nodes.
    await context.resume();
    if (
      activeCalibrationProbeRequestId !== requestId
      || !isCurrentPublisherCapture(sessionEpoch, expectedGeneration)
      || socket?.readyState !== WebSocket.OPEN
    ) return;
    if (
      audioContext !== context
      || document.visibilityState === 'hidden'
      || context.state !== 'running'
    ) {
      throw new Error(`Phone probe AudioContext is ${context.state}.`);
    }

    retireCalibrationProbePlayback();
    const startTime = context.currentTime + leadMs / 1000;
    const playback = {
      requestId,
      sessionEpoch,
      generation: expectedGeneration,
      context,
      nodes: [],
    };
    activeCalibrationProbePlayback = playback;
    let remainingNotes = PROBE_NOTES.length;
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
      playback.nodes.push({ oscillator, gain });
      oscillator.addEventListener('ended', () => {
        remainingNotes -= 1;
        if (remainingNotes === 0 && activeCalibrationProbePlayback === playback) {
          activeCalibrationProbePlayback = null;
        }
      }, { once: true });
      oscillator.start(at);
      oscillator.stop(at + PROBE_NOTE_SECONDS);
    }

    // Scheduling the nodes is the irreversible side effect. Retire the local
    // request before acknowledging it so a later status/retry cannot revive the
    // same identity on this page. The separate playback owner remains live
    // until every scheduled node ends or a capture/session boundary retires it.
    if (
      activeCalibrationProbeRequestId !== requestId
      || !isCurrentPublisherCapture(sessionEpoch, expectedGeneration)
    ) return;
    activeCalibrationProbeRequestId = null;
    if (socket?.readyState !== WebSocket.OPEN) {
      retireCalibrationProbePlayback();
      return;
    }
    const result = audioTransport.sendControlJson({
      type: 'calibration-probe-played',
      target: 'mic',
      requestId,
      // The same truncation framePcm applies. The server compares this against
      // the generation it read off a PCM frame header, which is a uint32.
      generation: expectedGeneration,
    });
    if (!result.sent) {
      retireCalibrationProbePlayback();
      if (result.reason === 'disconnected') markPublisherAuthorityStale();
    }
  } catch (error) {
    console.warn('phone calibration probe failed', error);
    if (
      activeCalibrationProbePlayback?.requestId === requestId
      && activeCalibrationProbePlayback?.sessionEpoch === sessionEpoch
      && activeCalibrationProbePlayback?.generation === expectedGeneration
      && activeCalibrationProbePlayback?.context === context
    ) {
      retireCalibrationProbePlayback();
    }
    if (
      activeCalibrationProbeRequestId !== requestId
      || !isCurrentPublisherCapture(sessionEpoch, expectedGeneration)
    ) return;
    activeCalibrationProbeRequestId = null;
    if (socket?.readyState !== WebSocket.OPEN) return;
    const result = audioTransport.sendControlJson({
      type: 'calibration-probe-failed',
      target: 'mic',
      requestId,
      generation: expectedGeneration,
      reason: error instanceof Error ? error.message : String(error),
    });
    if (!result.sent && result.reason === 'disconnected') markPublisherAuthorityStale();
  }
}

function dispatchRelayEvent(type, detail = {}) {
  window.dispatchEvent(new CustomEvent(type, { detail }));
}

function finishMicrophoneSession(reason, { releaseMic = false, afterEnded = null } = {}) {
  return micLifecycle.run({
    stop: () => stop(false, { releaseMic }),
    isCurrent: (stoppedEpoch) => publisherSessionEpoch === stoppedEpoch,
    onEnded: () => {
      dispatchRelayEvent('relay-microphone-ended', { reason });
      afterEnded?.();
    },
  });
}

function handleServerMessage(
  message,
  sessionEpoch = publisherSessionEpoch,
  expectedGeneration = captureGeneration >>> 0,
) {
  if (message.type === 'error') {
    setStatus('Error', message.message);
    // Protocol errors are not transport failures. Retrying the publisher after
    // a semantic rejection used to make superseded tabs fight forever.
    return;
  }

  if (message.type === 'audio-uplink-health-ack') {
    const ackGeneration = message.captureGeneration;
    const healthRequestId = message.healthRequestId;
    if (
      message.version !== 1
      || !Number.isInteger(ackGeneration)
      || ackGeneration < 0
      || ackGeneration > 0xffff_ffff
      || !Number.isInteger(healthRequestId)
      || healthRequestId < 0
      || healthRequestId > 0xffff_ffff
      || (ackGeneration >>> 0) !== (expectedGeneration >>> 0)
      || !isCurrentPublisherCapture(sessionEpoch, expectedGeneration)
      || !publisherCommandLiveness.noteAck(ackGeneration, healthRequestId, performance.now())
    ) return;
    settleCaptureClippingHealth(healthRequestId);
    refreshPublisherCommandChannel();
    return;
  }

  if (message.type === 'command-rejected') {
    // The rejection is visible, and it also invalidates the local claim that
    // this socket is currently authorized to mutate server-owned controls.
    const owner = message.owner ?? null;
    restoreLastKnownControl(message.command);
    resetPublisherCommandFreshness();
    publishPublisherCommandAuthority();
    updateSingerControls();
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
    dispatchRelayEvent('relay-calibration-command-rejected', {
      reason: message.reason ?? 'unknown',
    });
    return;
  }

  if (message.type === 'mic-busy') {
    const owner = message.owner ?? null;
    setStatus('Microphone is in use', owner ? `${owner.nickname} has the mic.` : 'Another participant has the mic.');
    dispatchRelayEvent('relay-mic-busy', { owner });
    finishMicrophoneSession('busy').catch(console.error);
    return;
  }

  if (message.type === 'mic-takeover-rejected') {
    const owner = message.owner ?? null;
    setStatus('Takeover changed', owner ? `${owner.nickname} has the mic now.` : 'The mic state changed.');
    dispatchRelayEvent('relay-mic-takeover-rejected', { owner, reason: message.reason });
    finishMicrophoneSession('takeover-rejected').catch(console.error);
    return;
  }

  if (message.type === 'mic-revoked') {
    setStatus('Microphone handed off', message.message ?? 'Another participant now has the mic.');
    finishMicrophoneSession('revoked').catch(console.error);
    return;
  }

  if (message.type === 'publisher-superseded') {
    setStatus('Microphone moved to another tab', message.message ?? 'A newer microphone capture is active.');
    finishMicrophoneSession('superseded').catch(console.error);
    return;
  }

  if (
    message.type === 'registered'
    && message.role === 'publisher'
    && isCurrentPublisherCapture(sessionEpoch, expectedGeneration)
  ) {
    pendingPublisherTakeoverOwnerId = null;
    publisherAuthorityFresh = true;
    publishPublisherCommandAuthority();
    updateSingerControls();
    void audioTransport.prefer(message.mediaTransport ?? null).then((preferred) => {
      if (!isCurrentPublisherCapture(sessionEpoch, expectedGeneration)) return;
      const path = preferred ? 'WebTransport datagrams' : 'WebSocket fallback';
      if (micCaptureRecovery.status().recovering) {
        setStatus(
          'Microphone connected',
          `${audioContext?.sampleRate ?? '--'} Hz · ${path} · waiting for fresh PCM`,
        );
      } else {
        setStatus('Microphone is live', `${audioContext?.sampleRate ?? '--'} Hz mono PCM · ${path}`);
      }
      sendAudioUplinkHealth();
    });
    updateMixLabels();
    dispatchRelayEvent('relay-microphone-started');
    return;
  }

  if (message.type === 'source-status') {
    liveMixActive = Boolean(message.active);
    const nextFineTune = Number(message.vocalFineTuneMs);
    if (Number.isFinite(nextFineTune)) {
      lastKnownControlSnapshot = {
        ...lastKnownControlSnapshot,
        vocalFineTuneMs: nextFineTune,
      };
      publisherSourceStatusFresh = true;
      if (!sliderIsBusy(vocalFineTune)) {
        vocalFineTune.value = String(nextFineTune);
        updateVocalFineTuneLabel();
      }
    }
    publishPublisherCommandAuthority();
    updateSingerControls();
    return;
  }

  if (message.type === 'mix-settings') {
    const nextGain = Number(message.micGainDb ?? 24);
    if (Number.isFinite(nextGain)) {
      lastKnownControlSnapshot = {
        ...lastKnownControlSnapshot,
        micGainDb: nextGain,
      };
      publisherMixSettingsFresh = true;
      if (!sliderIsBusy(micGain)) micGain.value = String(nextGain);
    }
    songLevel.value = String(FIXED_SONG_LEVEL);
    updateMixLabels();
    publishPublisherCommandAuthority();
    updateSingerControls();
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
      // A new authoritative request supersedes any future playback left by an
      // older request in this same capture; overlapping probe waveforms are not
      // valid calibration evidence.
      retireCalibrationProbePlayback();
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

function isCurrentPublisherCapture(sessionEpoch, expectedGeneration) {
  return isCurrentPublisherSession(sessionEpoch)
    && (captureGeneration >>> 0) === (expectedGeneration >>> 0);
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

function beginCaptureRecovery(reason) {
  if (!publisherActive || !audioContext) return;
  micCaptureRecovery.beginRecovery(captureSnapshot(), reason);
  setStatus(
    'Recovering microphone…',
    'Waiting for the audio clock and fresh microphone samples before declaring recovery.',
  );
  resumePublisherAudioContext();
}

function recoverPublisherAudio() {
  if (!publisherActive) return;
  const foreground = micCaptureRecovery.noteForeground(captureSnapshot());
  setStatus(
    'Recovering microphone…',
    'Foregrounded; waiting for the audio clock and fresh microphone samples.',
  );
  resumePublisherAudioContext();
  if (foreground.rebuild) void rebuildPublisherCaptureGraph('foreground-discontinuity');
}

function schedulePublisherReconnect(
  sessionEpoch = publisherSessionEpoch,
  expectedGeneration = captureGeneration >>> 0,
) {
  if (!isCurrentPublisherCapture(sessionEpoch, expectedGeneration)) return;
  clearSocketReconnect();
  const timer = setTimeout(() => {
    if (socketReconnectTimer !== timer) return;
    socketReconnectTimer = null;
    if (!isCurrentPublisherCapture(sessionEpoch, expectedGeneration)) return;
    connectPublisherSocket(sessionEpoch, expectedGeneration).catch(() => {
      if (!isCurrentPublisherCapture(sessionEpoch, expectedGeneration)) return;
      setStatus('Reconnecting microphone…', 'Relay is still unavailable; retrying automatically.');
      schedulePublisherReconnect(sessionEpoch, expectedGeneration);
    });
  }, publisherReconnectBackoff.nextDelayMs());
  socketReconnectTimer = timer;
}

function adoptSocket(ws) {
  const previous = socket;
  socket = ws;
  resetPublisherHealthRequestCorrelation();
  resetPublisherCommandFreshness();
  publishPublisherCommandAuthority();
  updateSingerControls();
  if (previous && previous !== ws) {
    try {
      previous.close();
    } catch {}
  }
}

async function connectPublisherSocket(
  sessionEpoch = publisherSessionEpoch,
  expectedGeneration = captureGeneration >>> 0,
) {
  if (!isCurrentPublisherCapture(sessionEpoch, expectedGeneration)) return;
  clearSocketReconnect();

  const ws = await connectSocket();
  if (!isCurrentPublisherCapture(sessionEpoch, expectedGeneration)) {
    ws.close();
    return;
  }

  adoptSocket(ws);
  publisherReconnectBackoff.noteConnected(performance.now());

  const registration = {
    type: 'register',
    role: 'publisher',
    sampleRate: audioContext.sampleRate,
    captureGeneration: expectedGeneration,
    initialSequence: capturePacketSequence >>> 0,
    audioPacketVersion: AUDIO_PACKET_VERSION,
  };
  if (pendingPublisherTakeoverOwnerId) {
    registration.takeoverExpectedOwnerId = pendingPublisherTakeoverOwnerId;
  }
  ws.send(JSON.stringify(registration));
  audioTransport.bind(ws, { sampleRate: audioContext.sampleRate });
  publisherCommandLiveness.begin(expectedGeneration, performance.now());
  refreshPublisherCommandChannel();
  publisherControlConnections += 1;

  ws.addEventListener('message', (event) => {
    if (
      socket !== ws
      || !isCurrentPublisherCapture(sessionEpoch, expectedGeneration)
      || typeof event.data !== 'string'
    ) return;
    handleServerMessage(JSON.parse(event.data), sessionEpoch, expectedGeneration);
  });

  ws.addEventListener('close', () => {
    if (socket !== ws) return;
    publisherReconnectBackoff.noteClosed(performance.now());
    activeCalibrationProbeRequestId = null;
    audioTransport.unbind(ws);
    socket = null;
    resetPublisherHealthRequestCorrelation();
    resetPublisherCommandFreshness();
    publishPublisherCommandAuthority();
    updateSingerControls();
    if (!isCurrentPublisherCapture(sessionEpoch, expectedGeneration)) return;
    setStatus('Reconnecting microphone…', 'Relay connection closed; microphone capture stays active.');
    schedulePublisherReconnect(sessionEpoch, expectedGeneration);
  });

  ws.addEventListener('error', () => {
    try {
      ws.close();
    } catch {}
  });
}

function restartPublisherConnectionForGeneration(sessionEpoch, generation) {
  if (!isCurrentPublisherCapture(sessionEpoch, generation)) return;
  clearSocketReconnect();
  const previous = socket;
  if (previous) {
    audioTransport.unbind(previous);
    socket = null;
    resetPublisherHealthRequestCorrelation();
    resetPublisherCommandFreshness();
    publishPublisherCommandAuthority();
    updateSingerControls();
    try {
      previous.close();
    } catch {}
  }
  audioTransport.close();
  publisherReconnectBackoff.reset();
  connectPublisherSocket(sessionEpoch, generation).catch(() => {
    if (!isCurrentPublisherCapture(sessionEpoch, generation)) return;
    setStatus('Reconnecting microphone…', 'Capture restarted; reconnecting the new sample generation.');
    schedulePublisherReconnect(sessionEpoch, generation);
  });
}

function rebuildPublisherCaptureGraph(reason) {
  if (captureGraphRebuildPromise) return captureGraphRebuildPromise;

  const sessionEpoch = publisherSessionEpoch;
  const expectedGeneration = captureGeneration >>> 0;
  const captureContext = audioContext;
  const captureStream = mediaStream;
  const replacedGraph = activeCaptureGraph;

  const promise = Promise.resolve().then(() => {
    if (
      !isCurrentPublisherCapture(sessionEpoch, expectedGeneration)
      || audioContext !== captureContext
      || mediaStream !== captureStream
      || activeCaptureGraph !== replacedGraph
    ) return false;

    disposeCaptureGraph(replacedGraph);
    if (activeCaptureGraph === replacedGraph) activeCaptureGraph = null;
    if (activeNode === replacedGraph?.capture) activeNode = null;

    const generation = advanceCaptureGeneration(reason);
    restartPublisherConnectionForGeneration(sessionEpoch, generation);
    if (!isCurrentPublisherCapture(sessionEpoch, generation)) return false;

    installCaptureGraph(sessionEpoch, captureStream, captureContext);
    micCaptureRecovery.noteGraphRebuilt(captureSnapshot());
    startCaptureWatchdog(sessionEpoch, generation);
    setStatus(
      'Recovering microphone…',
      'Capture graph rebuilt; waiting for fresh PCM before declaring recovery.',
    );
    return true;
  }).catch((error) => {
    console.warn('Microphone capture graph rebuild failed', error);
    if (isCurrentPublisherSession(sessionEpoch)) {
      void finishMicrophoneSession('capture-rebuild-failed', {
        // Rebuild failure is the same recoverable local-source class as a
        // hardware-ended track. Do not bypass the server reconnect grace with
        // an explicit room-Mic release.
        releaseMic: false,
        afterEnded: () => {
          setStatus(
            'Microphone interrupted',
            'Capture recovery failed. Retry Mic to start a fresh capture.',
          );
        },
      }).catch(console.error);
    }
    return false;
  }).finally(() => {
    if (captureGraphRebuildPromise === promise) captureGraphRebuildPromise = null;
  });

  captureGraphRebuildPromise = promise;
  return promise;
}

async function stop(setIdle = true, { releaseMic = true } = {}) {
  // Revoke this session before any asynchronous close can yield. Everything
  // after the first await is allowed to touch only captured old resources.
  const stoppedEpoch = ++publisherSessionEpoch;
  micStartup.cancel();
  publisherStarting = false;
  activeCalibrationProbeRequestId = null;
  retireCalibrationProbePlayback();
  clearSocketReconnect();
  stopAudioUplinkHealthReporting();
  stopCaptureWatchdog();
  micCaptureRecovery.stop();

  const closingSocket = socket;
  const closingStream = mediaStream;
  const closingGraph = activeCaptureGraph;
  const closingNode = activeNode;
  const closingContext = audioContext;
  const wasPublisherActive = publisherActive;

  socket = null;
  resetPublisherHealthRequestCorrelation();
  resetPublisherCommandFreshness();
  mediaStream = null;
  activeCaptureGraph = null;
  activeNode = null;
  captureGraphEpoch += 1;
  captureGraphRebuildPromise = null;
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
  if (closingGraph) disposeCaptureGraph(closingGraph);
  else if (closingNode) {
    try {
      closingNode.disconnect();
    } catch {}
  }
  setPublisherActive(false);

  liveMixActive = false;
  latestMixHealth = null;
  latestLocalMicLevel = null;
  captureAppliedSettings = null;
  dispatchRelayEvent('relay-local-mic-level', {
    active: false,
    captureGeneration: captureGeneration >>> 0,
    peakDbfs: null,
    rmsDbfs: null,
    spectrumBands: null,
    f0Hz: null,
    pitchConfidence: 0,
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

    // Plain false values in getUserMedia are preferences. If the live track
    // reports that browser voice processing is still on, tighten only features
    // whose own capability list proves exact false is available.
    await micStartup.wait(
      startup,
      enforceUnprocessedCapture(preparedStream),
      { stage: 'configuring clean microphone input' },
    );

    preparedContext = new AudioContext({ latencyHint: 'interactive' });
    const captureContext = preparedContext;
    captureContext.addEventListener('statechange', () => {
      if (!publisherActive || audioContext !== captureContext) return;
      if (captureContext.state === 'closed') {
        // A closed AudioContext is terminal: resume() cannot revive it and the
        // capture watchdog deliberately rebuilds only while the context is
        // running. Treat unexpected closure like a local hardware failure and
        // preserve the bounded server Mic grace for a user-gesture retry.
        finishMicrophoneSession('context-closed', {
          releaseMic: false,
          afterEnded: () => {
            setStatus(
              'Microphone interrupted',
              'The microphone audio engine closed. Retry Mic to reconnect it.',
            );
          },
        }).catch(console.error);
        return;
      }
      if (shouldRequestAudioResume(captureContext.state)) {
        beginCaptureRecovery(`context-${captureContext.state}`);
      }
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
    captureAppliedSettings = readCaptureSettings(captureStream);
    setPublisherActive(true);
    publisherStarting = false;
    micStartup.complete(startup);

    // A websocket reconnect keeps this generation. Only a true capture-clock
    // boundary (new Mic session or rebuilt graph) advances it.
    const generation = advanceCaptureGeneration('publisher-start');
    latestMixHealth = null;
    publisherControlConnections = 0;
    startAudioUplinkHealthReporting();

    // Track lifetime belongs to the Mic session, not to one graph generation.
    // Rebuilding a stuck worklet must not make later mute/unmute/ended events stale.
    const captureIsCurrent = () => isCurrentPublisherSession(sessionEpoch)
      && mediaStream === captureStream
      && audioContext === captureContext;
    const [track] = captureStream.getAudioTracks();
    let captureConfigurationRefreshPromise = null;
    const refreshCaptureConfiguration = () => {
      if (!captureIsCurrent() || captureConfigurationRefreshPromise) return;
      captureConfigurationRefreshPromise = (async () => {
        // WebKit can reconfigure a shared capture audio unit after startup.
        // Re-prove the applied settings and re-tighten controllable processing
        // instead of trusting the one snapshot taken at getUserMedia time.
        await enforceUnprocessedCapture(captureStream);
        if (!captureIsCurrent()) return;
        captureAppliedSettings = readCaptureSettings(captureStream);
        renderGainAdvice();

        // WebKit may change the underlying input without ending the live track
        // and may surface that only as configurationchange. Do not send an old-
        // generation health snapshot after observing a new physical input.
        if (
          activeCaptureGraph
          && rebuildCaptureForInputDeviceChange(activeCaptureGraph)
        ) return;
        sendAudioUplinkHealth();
      })().catch((error) => {
        console.warn('Microphone capture configuration refresh failed', error);
      }).finally(() => {
        captureConfigurationRefreshPromise = null;
      });
    };
    captureInputMuted = track?.muted === true;
    track?.addEventListener('configurationchange', refreshCaptureConfiguration);
    track?.addEventListener('mute', () => {
      if (!captureIsCurrent()) return;
      captureInputMuted = true;
      sendAudioUplinkHealth();
      beginCaptureRecovery('input-muted');
    });
    track?.addEventListener('unmute', () => {
      if (!captureIsCurrent()) return;
      captureInputMuted = false;
      sendAudioUplinkHealth();
      beginCaptureRecovery('input-unmuted');
    });
    track?.addEventListener('ended', () => {
      if (!captureIsCurrent()) return;
      finishMicrophoneSession('input-ended', {
        // A hardware/route loss is not an explicit user release. Close the
        // publisher transport and let the server's Mic reconnect grace preserve
        // ownership briefly, so a user-gesture Retry Mic can restore the local
        // capture without another participant racing into the lease.
        releaseMic: false,
        afterEnded: () => {
          setStatus('Microphone interrupted', 'The audio input ended. Retry Mic to reconnect it.');
        },
      }).catch(console.error);
    });

    micCaptureRecovery.start(captureSnapshot(), 'startup');
    installCaptureGraph(sessionEpoch, captureStream, captureContext);
    startCaptureWatchdog(sessionEpoch, generation);

    publisherButton.disabled = true;
    updateSingerControls();
    setStatus(
      'Connecting microphone…',
      `${captureContext.sampleRate} Hz capture graph started; waiting for fresh PCM and Relay.`,
    );

    publisherReconnectBackoff.reset();
    try {
      await connectPublisherSocket(sessionEpoch, generation);
    } catch {
      if (!isCurrentPublisherCapture(sessionEpoch, generation)) return;
      setStatus('Reconnecting microphone…', 'Initial Relay connection failed; retrying automatically.');
      schedulePublisherReconnect(sessionEpoch, generation);
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

async function requestPublisherStart(
  takeoverExpectedOwnerId = null,
  { preserveMicOwnership = false } = {},
) {
  if (publisherStartRequest) return publisherStartRequest;

  const request = (async () => {
    try {
      // A self-owner recovery must replace the damaged local capture without
      // opening a room-ownership race. Ordinary Take Mic/takeover still releases
      // any prior local Mic before acquiring through the normal server path.
      await stop(false, { releaseMic: !preserveMicOwnership });
      await startPublisher(takeoverExpectedOwnerId);
    } catch (error) {
      if (error?.code === 'mic-startup-cancelled') return;
      console.error(error);
      const message = error instanceof Error ? error.message : String(error);
      setStatus('Could not start microphone', message);
      await stop(false, { releaseMic: false });
      dispatchRelayEvent('relay-microphone-start-failed', {
        message,
        takeoverExpectedOwnerId,
      });
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

window.addEventListener('relay-retry-microphone', () => {
  requestPublisherStart(null, { preserveMicOwnership: true }).catch(console.error);
});

function notePublisherBackgrounded() {
  activeCalibrationProbeRequestId = null;
  retireCalibrationProbePlayback();
  if (!publisherActive) return;

  // iOS may freeze timers immediately after the lifecycle edge, so do not
  // rely on a later hidden-state health report to fence media-path diagnosis.
  audioTransport.noteSourceIneligibleBoundary();
  micCaptureRecovery.noteHidden(captureSnapshot());
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    notePublisherBackgrounded();
    return;
  }
  recoverPublisherAudio();
});
window.addEventListener('pagehide', notePublisherBackgrounded);
window.addEventListener('pageshow', recoverPublisherAudio);

window.addEventListener('relay-release-microphone', () => {
  if (!publisherActive) return;
  finishMicrophoneSession('released', {
    releaseMic: true,
    afterEnded: () => {
      setStatus('Microphone released', 'This phone is no longer using the microphone.');
    },
  }).catch(console.error);
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
  if (!publisherCommandAuthority().actionable || !Number.isFinite(recommended)) return;
  micGain.value = String(Math.max(0, Math.min(MAX_RECOMMENDED_MIC_GAIN_DB, Math.round(recommended))));
  markSliderTouched(micGain);
  sendMixSettings();
});

window.addEventListener('relay-locale-changed', () => {
  renderGainAdvice();
  updateCalibrateButton();
});

calibrateButton.addEventListener('click', () => {
  if (!publisherCommandAuthority(
    roomSongAvailable === true && roomCanStartCalibration === true,
  ).actionable) return;
  const result = audioTransport.sendControlJson({ type: 'start-timing-calibration' });
  if (!result.sent) {
    if (result.reason === 'disconnected') markPublisherAuthorityStale();
    calibrateStatus.textContent = result.reason === 'congested'
      ? 'Calibration not started: microphone uplink congested.'
      : 'Calibration not started: Relay is disconnected.';
  }
});

updateMixLabels();
updateCalibrateButton();
updateSingerControls();
publishPublisherCommandAuthority();
setStatus('Idle', 'Take the mic when you are ready.');
