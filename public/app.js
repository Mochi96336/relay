import { createMicCaptureGraph, parseMicVisualAnalysis } from './mic-capture-graph.js';
import { CaptureClockRecovery } from './capture-clock-recovery.js';
import { CalibrationProbePlayback } from './calibration-probe-playback.js';
import { authorityState } from './authority-freshness.js';
import { PublisherCommandLiveness } from './publisher-command-liveness.js';
import { sendParticipantAuthentication } from './participant-auth.js';
import { MIC_GAIN_KEY, storeNumber, storedNumber } from './device-preferences.js';
await window.relayIdentityReady;
import { PreferredAudioTransport } from './audio-transport.js';
import { createMicOpusTrial } from './mic-opus-trial.js';
import { MicBitratePolicy } from './mic-bitrate-policy.js';
import { localFileMix } from './local-file-mix.js';
const micBitratePolicy = new MicBitratePolicy();
const micCodecConfig = await fetch('/mic-codec-config', { cache: 'no-store', signal: AbortSignal.timeout(3000) })
  .then(response => response.ok ? response.json() : { opus: false }).catch(() => ({ opus: false }));
let micOpus = null;
import { classifyCaptureDispatch } from './capture-dispatch.js';
import { shouldRequestAudioResume } from './audio-context-recovery.js';
import { MicCaptureRecoveryWatchdog } from './mic-capture-recovery.js';
import { MicStartupCancelledError, MicStartupGate } from './mic-startup.js';
import {
  captureClippingSnapshot,
  captureLevelSnapshot,
  enforceUnprocessedCapture,
  readCaptureSettings,
} from './capture-observability.js';
import { MicLifecycleTransaction } from './mic-lifecycle-transaction.js';
const t = (key, vars) => window.relayI18n?.t(key, vars) ?? key;
import { splitPcmForPacketLimit } from './audio-packetizer.js';
import { createReconnectBackoff } from './reconnect-backoff.js';
import { wsUrl } from './ws-url.js';
import {
  FIXED_SONG_LEVEL,
  acceptMixSettings,
  acceptVocalFineTune,
  lastKnownControls,
  listenForSingerInput,
  micGainDb,
  restoreLastKnownControl,
  setSingerControlsEnabled,
  signed,
  updateMixLabels,
} from './mix-controls.js';
import {
  countUplinkDrop,
  forgetUnsettledUplinkHealth,
  noteCaptureClipping,
  noteCaptureDispatch,
  noteUplinkHealthSent,
  resetUplinkEvidence,
  settleCaptureClippingHealth,
  uplinkEvidenceReport,
} from './uplink-evidence.js';

const publisherButton = document.querySelector('#start-publisher');

// Mic audio on a WebSocket-only page rides this socket: reconnect fast, back
// off only while it keeps failing. See reconnect-backoff.js.
const publisherReconnectBackoff = createReconnectBackoff();
const AUDIO_UPLINK_HEALTH_INTERVAL_MS = 1000;
// Every message type the publisher socket's readers take: handleServerMessage
// and the audio transport's repeat-request and health handlers. Relay
// broadcasts this socket nothing else, so the repeat requests it sends do not
// queue behind status this page never reads. Replies arrive regardless.
const PUBLISHER_BROADCAST_TYPES = [
  'error',
  'audio-uplink-health-ack',
  'command-rejected',
  'calibration-command-rejected',
  'mic-busy',
  'mic-takeover-rejected',
  'mic-revoked',
  'publisher-superseded',
  'registered',
  'source-status',
  'mix-settings',
  'timing-calibration-status',
  'play-calibration-probe',
  'mix-health',
  'audio-retransmit-request',
];
const MIC_CAPTURE_WATCHDOG_INTERVAL_MS = 250;

let socket = null;
let socketReconnectTimer = null;
let audioContext = null;
let mediaStream = null;
let activeNode = null;
let activeCaptureGraph = null;
const captureClockRecovery = new CaptureClockRecovery();
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
let latestLocalMicLevel = null;
let captureAppliedSettings = null;
let roomSongAvailable = null;
let roomCanStartCalibration = null;
let pendingPublisherTakeoverOwnerId = null;
const calibrationProbePlayback = new CalibrationProbePlayback({
  getCapture: () => ({ context: audioContext, sessionEpoch: publisherSessionEpoch, generation: captureGeneration >>> 0 }),
  isCurrentCapture: isCurrentPublisherCapture,
  isControlOpen: () => socket?.readyState === WebSocket.OPEN,
  sendControl: (message) => audioTransport.sendControlJson(message),
  onDisconnected: markPublisherAuthorityStale,
});
let publisherSessionEpoch = 0;

let captureInputGapSamples = 0;

function resetPublisherHealthRequestCorrelation() {
  // Once command-channel authority resets, no ACK from an older socket can be
  // accepted by handleServerMessage().
  publisherCommandLiveness.reset();
  forgetUnsettledUplinkHealth();
}

let captureInputMuted = false;
let publisherControlConnections = 0;
let audioUplinkHealthTimer = null;
// Seeded from the clock, not 0: a page reload starts a new module scope and
// would otherwise reuse the same first-ever generation number, which the
// server take as "nothing changed" and skip re-anchoring the mic timeline to
// the new capture. Wire format is a Uint32 (see framePcm below); the seconds
// component keeps this unique across any reload that is not the same
// millisecond as a previous one, which a real reload never is.
let captureGeneration = Date.now() >>> 0;
let captureGenerationReason = 'page-initialized';
let captureSampleCursor = 0;
let sampleSongCapture = null;
window.addEventListener('relay:sample-song-anchor-request', (event) => {
  const request = event.detail;
  const anchor = sampleSongCapture;
  if (!request || !anchor || !publisherActive || !audioContext
      || audioContext.state !== 'running' || anchor.generation !== captureGeneration) return;
  const age = performance.now() - anchor.observedAt;
  if (age < 0 || age > 250) return;
  const sampledAt = Number(request.sampledAtPerformanceMs);
  const contextAtObservation = audioContext.currentTime;
  const now = performance.now();
  if (!Number.isFinite(sampledAt) || now - sampledAt < 0 || now - sampledAt > 100) return;
  const index = anchor.firstSampleIndex
    + (contextAtObservation - anchor.contextTime + (sampledAt - now) / 1000) * audioContext.sampleRate;
  if (!Number.isFinite(index)) return;
  request.captureAnchor = {
    generation: captureGeneration, sampleRate: audioContext.sampleRate,
    sampleIndex: anchor.firstSampleIndex, mediaDeltaSeconds: (anchor.firstSampleIndex - index) / audioContext.sampleRate, uncertaintyMs: 40,
  };
});
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
  countUplinkDrop(sampleCount, reason);
}

function audioUplinkHealthPayload(healthRequestId) {
  return {
    type: 'audio-uplink-health',
    version: 1,
    captureGeneration: captureGeneration >>> 0,
    healthRequestId,
    captureGenerationReason,
    capturedSamples: captureSampleCursor,
    capturedAtPerformanceMs: performance.now(),
    captureClock: {
      contextSeconds: audioContext?.currentTime ?? null,
      originContextSeconds: activeCaptureGraph?.captureClockOriginContextTime ?? null,
      lastChunkContextSeconds: sampleSongCapture?.contextTime ?? null,
      lastChunkSampleIndex: sampleSongCapture?.firstSampleIndex ?? null,
      lastChunkObservedAtMs: sampleSongCapture?.observedAt ?? null,
      sampleRate: audioContext?.sampleRate ?? null,
    },
    inputGapSamples: captureInputGapSamples,
    inputGapActive: micCaptureRecovery.status().inputGapActive,
    inputMuted: captureInputMuted,
    // Browser/worklet observations only; none of these fields is a calibration gate.
    capture: captureAppliedSettings,
    captureLevel: captureLevelSnapshot(latestLocalMicLevel),
    ...uplinkEvidenceReport(latestLocalMicLevel),
    controlReconnects: Math.max(0, publisherControlConnections - 1),
    transport: { ...audioTransport.stats(), codec: micOpus ? 'opus' : 'pcm16',
      codecBitrate: micOpus ? micOpus.bitrate : (audioContext?.sampleRate ?? 48000) * 16,
      ...(micOpus ? { codecBitrateReason: micBitratePolicy.status().reason } : {}) },
  };
}

function adaptMicBitrate() {
  if (!micOpus || !publisherActive) return;
  const stats = audioTransport.stats();
  const recovery = stats.recovery;
  const nowMs = performance.now();
  const decision = micBitratePolicy.observe({
    nowMs, generation: captureGeneration, path: stats.path,
    eligible: document.visibilityState !== 'hidden' && audioContext?.state === 'running'
      && !captureInputMuted && !micCaptureRecovery.status().inputGapActive
      && sampleSongCapture !== null && nowMs - sampleSongCapture.observedAt < 1500,
    congestedRejects: stats.webSocketCongestedRejects + stats.webTransportCongestedRejects,
    audioBacklogMs: recovery.audioBacklogMs,
    // On WT this socket carries control only; its queue is not media backlog.
    queueAgeMs: stats.path === 'websocket' ? recovery.queueAgeMs : 0,
    mixPlayable: recovery.mixPlayable,
  });
  micOpus.setBitrate(decision.bitrate);
}

function sendAudioUplinkHealth() {
  maintainPublisherCommandChannel();
  adaptMicBitrate();
  if (!publisherActive || socket?.readyState !== WebSocket.OPEN) return false;
  const sentAtMs = performance.now();
  const healthRequestId = publisherCommandLiveness.beginHealthRequest(sentAtMs);
  if (healthRequestId === null) return false;
  const result = audioTransport.sendControlJson(audioUplinkHealthPayload(healthRequestId));
  if (!result.sent) {
    publisherCommandLiveness.cancelHealthRequest(healthRequestId);
  } else {
    noteUplinkHealthSent(healthRequestId, sentAtMs);
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
    if (!captureGraphRebuildPromise && captureClockRecovery.observe(captureSnapshot())) {
      void rebuildPublisherAudioContext();
    }
  }, MIC_CAPTURE_WATCHDOG_INTERVAL_MS);
}

function advanceCaptureGeneration(reason) {
  // Calibration probe playback is capture-scoped. Retire both a pending
  // AudioContext.resume() continuation and nodes already scheduled into the
  // future before changing the capture-clock identity.
  calibrationProbePlayback.retire();
  captureGeneration = ((captureGeneration >>> 0) + 1) >>> 0;
  captureGenerationReason = reason;
  captureSampleCursor = 0;
  sampleSongCapture = null;
  capturePacketSequence = 0;
  micBitratePolicy.reset();
  micOpus?.setBitrate(128000);
  micOpus?.reset(captureGeneration);
  captureInputGapSamples = 0;
  resetUplinkEvidence();
  captureInputMuted = mediaStream?.getAudioTracks?.()[0]?.muted === true;
  latestLocalMicLevel = null;
  audioTransport.resetStats();
  dispatchRelayEvent('relay-microphone-capture-generation', {
    captureGeneration: captureGeneration >>> 0,
    reason,
  });
  return captureGeneration >>> 0;
}

function disposeCaptureGraph(graph) {
  graph?.dispose();
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

function rebuildCaptureForInputDeviceChange(graph) {
  return graph?.checkInputDeviceChange() ?? false;
}

function announceCaptureRecovered() {
  dispatchRelayEvent('relay-microphone-recovered', {
    captureGeneration: captureGeneration >>> 0,
    sampleCursor: captureSampleCursor,
  });
  sendAudioUplinkHealth();
}

function submitMicVisualAnalysis(graph, pcm) {
  graph.submitVisualAnalysis(pcm);
}

// Return only after framing/encoding no longer reads the capture buffer.
function returnCaptureBuffer(graph, buffer) {
  graph.returnBuffer(buffer);
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
        noteCaptureClipping(clipping);
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
  if (Number.isFinite(pcmMessage.capturedAtContextTime)) {
    sampleSongCapture = {
      generation: captureGeneration, firstSampleIndex: chunkFirstSampleIndex,
      contextTime: pcmMessage.capturedAtContextTime, observedAt: performance.now(),
    };
  }

  const dispatch = classifyCaptureDispatch({
    currentContextTimeSeconds: graph.context.currentTime,
    capturedAtContextTimeSeconds: pcmMessage.capturedAtContextTime,
    fallbackCapturedAtContextTimeSeconds:
      graph.captureClockOriginContextTime + (chunkFirstSampleIndex / graph.context.sampleRate),
  });
  noteCaptureDispatch(dispatch);

  const recovery = micCaptureRecovery.observe(captureSnapshot(), {
    freshPcm: !dispatch.stale && captureInputMuted !== true,
  });
  if (recovery.recovered) announceCaptureRecovered();

  if (dispatch.stale) {
    recordUplinkDrop(pcm.byteLength / 2, 'capture-backlog');
    returnCaptureBuffer(graph, pcm);
    return;
  }

  submitMicVisualAnalysis(graph, pcm);

  if (micOpus) {
    if (micOpus.encode(pcm, capturePacketSequence, chunkFirstSampleIndex)) {
      capturePacketSequence = (capturePacketSequence + 1) >>> 0;
    }
    returnCaptureBuffer(graph, pcm);
    return;
  }

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
  returnCaptureBuffer(graph, pcm);
}

function handleCaptureProcessorError(graph) {
  if (!captureGraphIsCurrent(graph)) return;
  // Spend the existing one-shot recovery budget; a repeated terminal failure
  // enters reconnect grace rather than looping capture generations.
  const decision = micCaptureRecovery.noteProcessorError(captureSnapshot());
  if (decision.rebuild) {
    void rebuildPublisherCaptureGraph('processor-error');
    return;
  }
  if (!decision.exhausted) return;
  void finishMicrophoneSession('processor-error-repeated', {
    releaseMic: false,
  }).catch(console.error);
}

function installCaptureGraph(sessionEpoch, captureStream, captureContext) {
  const graph = createMicCaptureGraph({
    epoch: captureGraphEpoch + 1,
    sessionEpoch, stream: captureStream, context: captureContext,
    isCurrent: captureGraphIsCurrent,
    onCaptureMessage: handleCaptureWorkletMessage,
    onProcessorError: handleCaptureProcessorError,
    onInputDeviceChanged: () => { void rebuildPublisherCaptureGraph('input-device-changed'); },
    onInputDeviceRemoved: () => finishMicrophoneSession('input-device-removed', { releaseMic: false }),
    connectInput: localFileMix.connectInput,
  });
  // No callback is admitted until all graph resources are installed. Neither
  // failed preparation nor graph disposal owns publisher stream/context teardown.
  captureGraphEpoch = graph.epoch;
  activeCaptureGraph = graph;
  activeNode = graph.capture;
  return graph;
}

// recorder.js reads this so it can warn when Solo recording is started on the
// same device that is publishing the microphone.
window.relayActiveRole = null;

function publisherCommandChannelFresh(nowMs = performance.now()) {
  return socket?.readyState === WebSocket.OPEN
    && publisherCommandLiveness.status(nowMs).fresh;
}

function publisherCommandAuthority(serverAllowed = true) {
  return authorityState({
    authorityFresh: publisherAuthorityFresh
      && publisherMixSettingsFresh
      && publisherSourceStatusFresh,
    lastKnownSnapshot: lastKnownControls(),
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

function sendMixSettings() {
  if (!publisherCommandAuthority().actionable) {
    restoreLastKnownControl('set-mix');
    return false;
  }
  try {
    const result = audioTransport.sendControlJson({
      type: 'set-mix',
      micGainDb: micGainDb(),
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
  storeNumber(MIC_GAIN_KEY, micGainDb());
  updateMixLabels();
  return true;
}

function updateSingerControls() {
  setSingerControlsEnabled(publisherCommandAuthority().actionable);
}

/**
 * The direct socket skips the tunnel's detour (direct-socket.ts). A network
 * that blocks its port blocks it every time, so after one failure this page
 * stays on the tunnel instead of paying the wait on each reconnect.
 */
const DIRECT_SOCKET_OPEN_TIMEOUT_MS = 2_500;
let directSocketFailed = false;

async function connectSocket() {
  // Carries the Mic's PCM whenever WebTransport is unavailable.
  const tunnelUrl = wsUrl({ compress: false });
  const directUrl = wsUrl({ compress: false, direct: true });
  if (!directSocketFailed && directUrl !== tunnelUrl) {
    try {
      return await openSocket(directUrl, DIRECT_SOCKET_OPEN_TIMEOUT_MS);
    } catch {
      directSocketFailed = true;
    }
  }
  return openSocket(tunnelUrl);
}

function openSocket(url, timeoutMs = null) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    const timer = timeoutMs === null ? null : setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error('WebSocket connection timed out.'));
    }, timeoutMs);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      sendParticipantAuthentication(ws);
      resolve(ws);
    }, { once: true });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('WebSocket connection failed.'));
    }, { once: true });
  });
}

function clearSocketReconnect() {
  if (!socketReconnectTimer) return;
  clearTimeout(socketReconnectTimer);
  socketReconnectTimer = null;
}


function dispatchRelayEvent(type, detail = {}) {
  window.dispatchEvent(new CustomEvent(type, { detail }));
}

function finishMicrophoneSession(reason, { releaseMic = false } = {}) {
  return micLifecycle.run({
    stop: () => stop({ releaseMic }),
    isCurrent: (stoppedEpoch) => publisherSessionEpoch === stoppedEpoch,
    onEnded: () => dispatchRelayEvent('relay-microphone-ended', { reason }),
  });
}

function handleServerMessage(
  message,
  sessionEpoch = publisherSessionEpoch,
  expectedGeneration = captureGeneration >>> 0,
) {
  if (message.type === 'error') {
    // Protocol errors are not transport failures. Retrying the publisher after
    // a semantic rejection used to make superseded tabs fight forever.
    console.warn('[relay] server error:', message.message);
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
    // The control goes back to the Relay's value, and the rejection invalidates
    // the local claim that this socket may mutate server-owned controls.
    restoreLastKnownControl(message.command);
    resetPublisherCommandFreshness();
    publishPublisherCommandAuthority();
    updateSingerControls();
    return;
  }

  if (message.type === 'calibration-command-rejected') {
    dispatchRelayEvent('relay-calibration-command-rejected', {
      reason: message.reason ?? 'unknown',
    });
    return;
  }

  if (message.type === 'mic-busy') {
    const owner = message.owner ?? null;
    dispatchRelayEvent('relay-mic-busy', { owner });
    finishMicrophoneSession('busy').catch(console.error);
    return;
  }

  if (message.type === 'mic-takeover-rejected') {
    const owner = message.owner ?? null;
    dispatchRelayEvent('relay-mic-takeover-rejected', { owner, reason: message.reason });
    finishMicrophoneSession('takeover-rejected').catch(console.error);
    return;
  }

  if (message.type === 'mic-revoked') {
    finishMicrophoneSession('revoked').catch(console.error);
    return;
  }

  if (message.type === 'publisher-superseded') {
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
    void audioTransport.prefer(message.mediaTransport ?? null).then(() => {
      if (!isCurrentPublisherCapture(sessionEpoch, expectedGeneration)) return;
      sendAudioUplinkHealth();
    });
    updateMixLabels();
    dispatchRelayEvent('relay-microphone-started');
    return;
  }

  if (message.type === 'source-status') {
    if (acceptVocalFineTune(message)) publisherSourceStatusFresh = true;
    publishPublisherCommandAuthority();
    updateSingerControls();
    return;
  }

  if (message.type === 'mix-settings') {
    if (acceptMixSettings(message)) publisherMixSettingsFresh = true;
    publishPublisherCommandAuthority();
    updateSingerControls();
    return;
  }

  if (message.type === 'timing-calibration-status') {
    if (
      message.probeActive !== true || message.probePhase !== 'mic-requested'
    ) {
      calibrationProbePlayback.cancelPending();
    }
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
      void calibrationProbePlayback.play(requestId, Number(message.leadMs) || 200);
    }
    return;
  }

  // Mix health feeds the desktop source page; the Live surface has no use for it.
  if (message.type === 'mix-health') return;
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
  resumePublisherAudioContext();
}

function recoverPublisherAudio() {
  if (!publisherActive) return;
  const foreground = micCaptureRecovery.noteForeground(captureSnapshot());
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
    // The capture this registration describes already holds a local song.
    premixed: activeCaptureGraph?.premixed === true,
  };
  micBitratePolicy.floor = registration.premixed ? 64000 : 32000;
  if (registration.premixed) registration.localFileTitle = localFileMix.title;
  // This device's own last gain, so a new owner does not start from the
  // previous singer's.
  const rememberedGainDb = storedNumber(MIC_GAIN_KEY, 0, 40);
  if (rememberedGainDb !== null) registration.micGainDb = rememberedGainDb;
  if (pendingPublisherTakeoverOwnerId) {
    registration.takeoverExpectedOwnerId = pendingPublisherTakeoverOwnerId;
  }
  ws.send(JSON.stringify({ type: 'broadcast-subscribe', types: PUBLISHER_BROADCAST_TYPES }));
  ws.send(JSON.stringify(registration));
  audioTransport.bind(ws, { sampleRate: audioContext.sampleRate });
  publisherCommandLiveness.begin(expectedGeneration, performance.now());
  refreshPublisherCommandChannel();
  publisherControlConnections += 1;

  ws.addEventListener('message', (event) => {
    if (socket === ws) publisherCommandLiveness.noteInbound(performance.now());
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
    calibrationProbePlayback.cancelPending();
    audioTransport.unbind(ws);
    socket = null;
    resetPublisherHealthRequestCorrelation();
    resetPublisherCommandFreshness();
    publishPublisherCommandAuthority();
    updateSingerControls();
    if (!isCurrentPublisherCapture(sessionEpoch, expectedGeneration)) return;
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
    schedulePublisherReconnect(sessionEpoch, generation);
  });
}

// A Worklet replacement preserves the old context clock. Sustained clock loss
// needs a new context and a new capture generation; keep the existing track.
function rebuildPublisherAudioContext() {
  if (captureGraphRebuildPromise) return captureGraphRebuildPromise;
  const sessionEpoch = publisherSessionEpoch;
  const expectedGeneration = captureGeneration >>> 0;
  const oldContext = audioContext;
  const stream = mediaStream;
  const graph = activeCaptureGraph;
  let replacement = null;
  let committed = false;
  let timeout;
  const current = () => isCurrentPublisherCapture(sessionEpoch, expectedGeneration)
    && audioContext === oldContext && mediaStream === stream && activeCaptureGraph === graph;
  const promise = Promise.resolve().then(async () => {
    if (!current()) return false;
    replacement = new AudioContext({ latencyHint: 'interactive', ...(micCodecConfig.opus ? { sampleRate: 48000 } : {}) });
    const prepared = replacement;
    await Promise.race([
      (async () => {
        await prepared.audioWorklet.addModule('/capture-worklet.js');
        if (!current()) return;
        await prepared.resume();
      })(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('AudioContext recovery timed out')), 3000);
      }),
    ]);
    if (!current()) return false;
    if (prepared.state !== 'running') throw new Error('Replacement AudioContext is not running');
    committed = true;
    disposeCaptureGraph(graph);
    activeCaptureGraph = null;
    activeNode = null;
    audioContext = prepared;
    replacement = null;
    // The old context's state handler no longer owns the current publisher.
    void oldContext?.close().catch(() => {});
    prepared.addEventListener('statechange', () => {
      if (!publisherActive || audioContext !== prepared) return;
      if (prepared.state === 'closed') {
        void finishMicrophoneSession('context-closed', { releaseMic: false }).catch(console.error);
      } else if (shouldRequestAudioResume(prepared.state)) {
        beginCaptureRecovery(`context-${prepared.state}`);
      }
    });
    const generation = advanceCaptureGeneration('context-clock-underfed');
    installCaptureGraph(sessionEpoch, stream, prepared);
    micCaptureRecovery.noteGraphRebuilt(captureSnapshot());
    restartPublisherConnectionForGeneration(sessionEpoch, generation);
    startCaptureWatchdog(sessionEpoch, generation);
    console.warn('Microphone AudioContext replaced after sustained clock loss');
    return true;
  }).catch((error) => {
    console.warn('Microphone AudioContext recovery failed', error);
    // A failure from a retired session must not stop a newer Mic session.
    // Preparation failure leaves the existing capture intact. Only a failure
    // after retiring its graph needs the bounded user-gesture Retry Mic path.
    if (committed && isCurrentPublisherSession(sessionEpoch)) {
      void finishMicrophoneSession('context-rebuild-failed', { releaseMic: false }).catch(console.error);
    }
    return false;
  }).finally(() => {
    clearTimeout(timeout);
    if (replacement) void replacement.close().catch(() => {});
    if (captureGraphRebuildPromise === promise) captureGraphRebuildPromise = null;
  });
  captureGraphRebuildPromise = promise;
  return promise;
}

// Opening or closing a local file changes what the capture carries, and Relay
// mixes a premixed capture at unity. A new capture generation makes that
// switch at a sample boundary: no voice-gain samples are mixed as premixed or
// the other way round.
function syncLocalFileMode() {
  const graph = activeCaptureGraph;
  if (!publisherActive || !graph || graph.premixed === localFileMix.active) return;
  void rebuildPublisherCaptureGraph('local-file-mode').then((rebuilt) => {
    if (rebuilt) syncLocalFileMode();
  });
}
localFileMix.addEventListener('change', (event) => {
  const kind = event.detail?.kind;
  if (kind === 'mode') syncLocalFileMode();
  // Another file on the same premixed capture: only its name changes for the room.
  if (kind === 'file' && activeCaptureGraph?.premixed && socket?.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify({ type: 'set-local-file', title: localFileMix.title }));
    } catch {}
  }
});

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
    return true;
  }).catch((error) => {
    console.warn('Microphone capture graph rebuild failed', error);
    if (isCurrentPublisherSession(sessionEpoch)) {
      void finishMicrophoneSession('capture-rebuild-failed', {
        // Rebuild failure is the same recoverable local-source class as a
        // hardware-ended track. Do not bypass the server reconnect grace with
        // an explicit room-Mic release.
        releaseMic: false,
      }).catch(console.error);
    }
    return false;
  }).finally(() => {
    if (captureGraphRebuildPromise === promise) captureGraphRebuildPromise = null;
  });

  captureGraphRebuildPromise = promise;
  return promise;
}

async function stop({ releaseMic = true } = {}) {
  // Revoke this session before any asynchronous close can yield. Everything
  // after the first await is allowed to touch only captured old resources.
  const stoppedEpoch = ++publisherSessionEpoch;
  micStartup.cancel();
  publisherStarting = false;
  calibrationProbePlayback.retire();
  clearSocketReconnect();
  stopAudioUplinkHealthReporting();
  stopCaptureWatchdog();
  micCaptureRecovery.stop();
  captureClockRecovery.reset();

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
  micOpus?.close();
  micOpus = null;
  audioTransport.fallback.setEncodedBitrate(null);

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
  resetUplinkEvidence();
  captureInputGapSamples = 0;
  captureInputMuted = false;
  publisherControlConnections = 0;
  publisherButton.disabled = false;
  updateSingerControls();

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

    if (micCodecConfig.opus) {
      micOpus = await micStartup.wait(startup, createMicOpusTrial({
        bitrate: micCodecConfig.bitrate,
        onPacket: packet => {
          const result = audioTransport.send(packet);
          if (!result.sent) recordUplinkDrop(960, result.reason ?? 'disconnected');
        },
        onDrop: recordUplinkDrop,
        onBitrate: bitrate => audioTransport.fallback.setEncodedBitrate(bitrate),
        onError: error => {
          console.error('Mic Opus failed', error);
          if (publisherActive) finishMicrophoneSession('opus-failed', { releaseMic: false }).catch(console.error);
        },
      }), { stage: 'preparing compressed microphone audio', dispose: encoder => encoder.close() });
      audioTransport.fallback.setEncodedBitrate(micCodecConfig.bitrate);
    }
    preparedContext = new AudioContext({ latencyHint: 'interactive', ...(micCodecConfig.opus ? { sampleRate: 48000 } : {}) });
    if (micCodecConfig.opus && preparedContext.sampleRate !== 48000) throw new Error('Opus trial requires 48 kHz capture');
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
    publisherControlConnections = 0;
    startAudioUplinkHealthReporting();

    // Track lifetime belongs to the Mic session, not to one graph generation.
    // Rebuilding a stuck worklet must not make later mute/unmute/ended events stale.
    const captureIsCurrent = () => isCurrentPublisherSession(sessionEpoch)
      && mediaStream === captureStream
      && audioContext !== null;
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
      }).catch(console.error);
    });

    captureClockRecovery.reset();
    micCaptureRecovery.start(captureSnapshot(), 'startup');
    installCaptureGraph(sessionEpoch, captureStream, captureContext);
    startCaptureWatchdog(sessionEpoch, generation);

    publisherButton.disabled = true;
    updateSingerControls();

    publisherReconnectBackoff.reset();
    try {
      await connectPublisherSocket(sessionEpoch, generation);
    } catch {
      if (!isCurrentPublisherCapture(sessionEpoch, generation)) return;
      schedulePublisherReconnect(sessionEpoch, generation);
    }
  } finally {
    if (!publisherActive) {
      micOpus?.close();
      micOpus = null;
      audioTransport.fallback.setEncodedBitrate(null);
    }
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
      await stop({ releaseMic: !preserveMicOwnership });
      await startPublisher(takeoverExpectedOwnerId);
    } catch (error) {
      if (error?.code === 'mic-startup-cancelled') return;
      console.error(error);
      const message = error instanceof Error ? error.message : String(error);
      await stop({ releaseMic: false });
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
  calibrationProbePlayback.retire();
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
  }).catch(console.error);
});

listenForSingerInput({ onMix: sendMixSettings });

// The Realign action (calibration-ui.js) asks for a calibration; the command
// goes out over this page's publisher transport.
window.addEventListener('relay-start-timing-calibration', () => {
  if (!publisherCommandAuthority(
    roomSongAvailable === true && roomCanStartCalibration === true,
  ).actionable) return;
  const result = audioTransport.sendControlJson({ type: 'start-timing-calibration' });
  if (!result.sent && result.reason === 'disconnected') markPublisherAuthorityStale();
});

updateMixLabels();
updateSingerControls();
publishPublisherCommandAuthority();
