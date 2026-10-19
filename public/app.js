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
import { classifyCaptureDispatch } from './capture-dispatch.js';
import { shouldRequestAudioResume } from './audio-context-recovery.js';
import { MicCaptureRecoveryWatchdog } from './mic-capture-recovery.js';
import { MicStartupCancelledError } from './mic-startup.js';
import { PublisherSession } from './publisher-session.js';
import {
  captureClippingSnapshot,
  captureLevelSnapshot,
  enforceUnprocessedCapture,
  readCaptureSettings,
} from './capture-observability.js';
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

let socketReconnectTimer = null;
const captureClockRecovery = new CaptureClockRecovery();
let captureWatchdogTimer = null;
let publisherAuthorityFresh = false;
let publisherMixSettingsFresh = false;
let publisherSourceStatusFresh = false;
const publisherSession = new PublisherSession({ closeMedia: () => audioTransport.close() });
const micStartup = publisherSession.startup;
const micCaptureRecovery = new MicCaptureRecoveryWatchdog();
const publisherCommandLiveness = new PublisherCommandLiveness();
let publishedPublisherCommandChannelFresh = false;
let latestLocalMicLevel = null;
let captureAppliedSettings = null;
let roomSongAvailable = null;
let roomCanStartCalibration = null;
let pendingPublisherTakeoverOwnerId = null;
const calibrationProbePlayback = new CalibrationProbePlayback({
  getCapture: () => ({ context: publisherSession.context, sessionEpoch: publisherSession.epoch, generation: publisherSession.generation >>> 0 }),
  isCurrentCapture: isCurrentPublisherCapture,
  isControlOpen: () => publisherSession.socket?.readyState === WebSocket.OPEN,
  sendControl: (message) => audioTransport.sendControlJson(message),
  onDisconnected: markPublisherAuthorityStale,
});

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
let captureSampleCursor = 0;
let sampleSongCapture = null;
window.addEventListener('relay:sample-song-anchor-request', (event) => {
  const request = event.detail;
  const anchor = sampleSongCapture;
  if (!request || !anchor || !publisherSession.active || !publisherSession.context
      || publisherSession.context.state !== 'running' || anchor.generation !== publisherSession.generation) return;
  const age = performance.now() - anchor.observedAt;
  if (age < 0 || age > 250) return;
  const sampledAt = Number(request.sampledAtPerformanceMs);
  const contextAtObservation = publisherSession.context.currentTime;
  const now = performance.now();
  if (!Number.isFinite(sampledAt) || now - sampledAt < 0 || now - sampledAt > 100) return;
  const index = anchor.firstSampleIndex
    + (contextAtObservation - anchor.contextTime + (sampledAt - now) / 1000) * publisherSession.context.sampleRate;
  if (!Number.isFinite(index)) return;
  request.captureAnchor = {
    generation: publisherSession.generation, sampleRate: publisherSession.context.sampleRate,
    sampleIndex: anchor.firstSampleIndex, mediaDeltaSeconds: (anchor.firstSampleIndex - index) / publisherSession.context.sampleRate, uncertaintyMs: 40,
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
    captureGeneration: publisherSession.generation >>> 0,
    healthRequestId,
    captureGenerationReason: publisherSession.generationReason,
    capturedSamples: captureSampleCursor,
    capturedAtPerformanceMs: performance.now(),
    captureClock: {
      contextSeconds: publisherSession.context?.currentTime ?? null,
      originContextSeconds: publisherSession.graph?.captureClockOriginContextTime ?? null,
      lastChunkContextSeconds: sampleSongCapture?.contextTime ?? null,
      lastChunkSampleIndex: sampleSongCapture?.firstSampleIndex ?? null,
      lastChunkObservedAtMs: sampleSongCapture?.observedAt ?? null,
      sampleRate: publisherSession.context?.sampleRate ?? null,
    },
    inputGapSamples: captureInputGapSamples,
    inputGapActive: micCaptureRecovery.status().inputGapActive,
    inputMuted: captureInputMuted,
    // Browser/worklet observations only; none of these fields is a calibration gate.
    capture: captureAppliedSettings,
    captureLevel: captureLevelSnapshot(latestLocalMicLevel),
    ...uplinkEvidenceReport(latestLocalMicLevel),
    controlReconnects: Math.max(0, publisherControlConnections - 1),
    transport: { ...audioTransport.stats(), codec: publisherSession.encoder ? 'opus' : 'pcm16',
      codecBitrate: publisherSession.encoder ? publisherSession.encoder.bitrate : (publisherSession.context?.sampleRate ?? 48000) * 16,
      ...(publisherSession.encoder ? { codecBitrateReason: micBitratePolicy.status().reason } : {}) },
  };
}

function adaptMicBitrate() {
  if (!publisherSession.encoder || !publisherSession.active) return;
  const stats = audioTransport.stats();
  const recovery = stats.recovery;
  const nowMs = performance.now();
  const decision = micBitratePolicy.observe({
    nowMs, generation: publisherSession.generation, path: stats.path,
    eligible: document.visibilityState !== 'hidden' && publisherSession.context?.state === 'running'
      && !captureInputMuted && !micCaptureRecovery.status().inputGapActive
      && sampleSongCapture !== null && nowMs - sampleSongCapture.observedAt < 1500,
    congestedRejects: stats.webSocketCongestedRejects + stats.webTransportCongestedRejects,
    audioBacklogMs: recovery.audioBacklogMs,
    // On WT this socket carries control only; its queue is not media backlog.
    queueAgeMs: stats.path === 'websocket' ? recovery.queueAgeMs : 0,
    mixPlayable: recovery.mixPlayable,
  });
  publisherSession.encoder.setBitrate(decision.bitrate);
}

function sendAudioUplinkHealth() {
  maintainPublisherCommandChannel();
  adaptMicBitrate();
  if (!publisherSession.active || publisherSession.socket?.readyState !== WebSocket.OPEN) return false;
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
    contextState: publisherSession.context?.state ?? 'closed',
    contextTime: publisherSession.context?.currentTime ?? 0,
    sampleCursor: captureSampleCursor,
    inputMuted: captureInputMuted,
  };
}

function stopCaptureWatchdog() {
  if (captureWatchdogTimer !== null) clearInterval(captureWatchdogTimer);
  captureWatchdogTimer = null;
}

function startCaptureWatchdog(
  sessionEpoch = publisherSession.epoch,
  expectedGeneration = publisherSession.generation >>> 0,
) {
  stopCaptureWatchdog();
  captureWatchdogTimer = setInterval(() => {
    if (!isCurrentPublisherCapture(sessionEpoch, expectedGeneration)) return;
    const decision = micCaptureRecovery.observe(captureSnapshot());
    if (decision.resume) resumePublisherAudioContext();
    if (decision.rebuild) void rebuildPublisherCaptureGraph('pcm-stall');
    if (!publisherSession.recovering && captureClockRecovery.observe(captureSnapshot())) {
      void rebuildPublisherAudioContext();
    }
  }, MIC_CAPTURE_WATCHDOG_INTERVAL_MS);
}

function advanceCaptureGeneration(reason) {
  // Calibration probe playback is capture-scoped. Retire both a pending
  // AudioContext.resume() continuation and nodes already scheduled into the
  // future before changing the capture-clock identity.
  calibrationProbePlayback.retire();
  publisherSession.advanceGeneration(reason);
  captureSampleCursor = 0;
  sampleSongCapture = null;
  capturePacketSequence = 0;
  micBitratePolicy.reset();
  publisherSession.encoder?.setBitrate(128000);
  publisherSession.encoder?.reset(publisherSession.generation);
  captureInputGapSamples = 0;
  resetUplinkEvidence();
  captureInputMuted = publisherSession.stream?.getAudioTracks?.()[0]?.muted === true;
  latestLocalMicLevel = null;
  audioTransport.resetStats();
  dispatchRelayEvent('relay-microphone-capture-generation', {
    captureGeneration: publisherSession.generation >>> 0,
    reason,
  });
  return publisherSession.generation >>> 0;
}

function captureGraphIsCurrent(graph) {
  return publisherSession.isCurrentGraph(graph);
}

function rebuildCaptureForInputDeviceChange(graph) {
  return graph?.checkInputDeviceChange() ?? false;
}

function announceCaptureRecovered() {
  dispatchRelayEvent('relay-microphone-recovered', {
    captureGeneration: publisherSession.generation >>> 0,
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
          captureGeneration: publisherSession.generation >>> 0,
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
      generation: publisherSession.generation, firstSampleIndex: chunkFirstSampleIndex,
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

  if (publisherSession.encoder) {
    if (publisherSession.encoder.encode(pcm, capturePacketSequence, chunkFirstSampleIndex)) {
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
    const packet = framePcm(segment.pcm, publisherSession.generation, sequence, firstSampleIndex);
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
    epoch: publisherSession.graphEpoch + 1,
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
  return publisherSession.adoptGraph(sessionEpoch, graph) ? graph : null;
}

// recorder.js reads this so it can warn when Solo recording is started on the
// same device that is publishing the microphone.
window.relayActiveRole = null;

function publisherCommandChannelFresh(nowMs = performance.now()) {
  return publisherSession.socket?.readyState === WebSocket.OPEN
    && publisherCommandLiveness.status(nowMs).fresh;
}

function publisherCommandAuthority(serverAllowed = true) {
  return authorityState({
    authorityFresh: publisherAuthorityFresh
      && publisherMixSettingsFresh
      && publisherSourceStatusFresh,
    lastKnownSnapshot: lastKnownControls(),
    commandChannelFresh: publisherCommandChannelFresh(),
    authorized: publisherSession.active,
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
    && publisherSession.active
    && publisherSession.socket?.readyState === WebSocket.OPEN
  ) {
    publishPublisherCommandAuthority();
    updateSingerControls();
    const staleSocket = publisherSession.socket;
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

function publishLocalMicState() {
  if (!publisherSession.active) resetPublisherCommandFreshness();
  // listen.js / recorder.js consume the legacy role, while Presence consumes
  // the explicit local lifecycle event so Release never depends on a server
  // ownership snapshot arriving first.
  window.relayActiveRole = publisherSession.active ? 'publisher' : null;
  dispatchRelayEvent('relay-microphone-local-state', { active: publisherSession.active });
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
  return publisherSession.end({
    stop: () => stop({ releaseMic }),
    onEnded: () => dispatchRelayEvent('relay-microphone-ended', { reason }),
  });
}

function handleServerMessage(
  message,
  sessionEpoch = publisherSession.epoch,
  expectedGeneration = publisherSession.generation >>> 0,
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

function isCurrentPublisherSession(sessionEpoch) {
  return publisherSession.isCurrentSession(sessionEpoch);
}

function isCurrentPublisherCapture(sessionEpoch, expectedGeneration) {
  return publisherSession.isCurrentCapture(sessionEpoch, expectedGeneration);
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
  if (!publisherSession.active || !publisherSession.context) return;
  if (!shouldRequestAudioResume(publisherSession.context.state)) return;
  try {
    const pending = publisherSession.context.resume();
    if (pending && typeof pending.catch === 'function') {
      pending.catch((error) => console.warn('Microphone AudioContext resume failed', error));
    }
  } catch (error) {
    console.warn('Microphone AudioContext resume failed', error);
  }
}

function beginCaptureRecovery(reason) {
  if (!publisherSession.active || !publisherSession.context) return;
  micCaptureRecovery.beginRecovery(captureSnapshot(), reason);
  resumePublisherAudioContext();
}

function recoverPublisherAudio() {
  if (!publisherSession.active) return;
  const foreground = micCaptureRecovery.noteForeground(captureSnapshot());
  resumePublisherAudioContext();
  if (foreground.rebuild) void rebuildPublisherCaptureGraph('foreground-discontinuity');
}

function schedulePublisherReconnect(
  sessionEpoch = publisherSession.epoch,
  expectedGeneration = publisherSession.generation >>> 0,
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

function adoptSocket(ws, sessionEpoch, expectedGeneration) {
  if (!publisherSession.bindSocket(sessionEpoch, expectedGeneration, ws)) return false;
  resetPublisherHealthRequestCorrelation();
  resetPublisherCommandFreshness();
  publishPublisherCommandAuthority();
  updateSingerControls();
  return true;
}

async function connectPublisherSocket(
  sessionEpoch = publisherSession.epoch,
  expectedGeneration = publisherSession.generation >>> 0,
) {
  if (!isCurrentPublisherCapture(sessionEpoch, expectedGeneration)) return;
  clearSocketReconnect();

  const ws = await connectSocket();
  if (!isCurrentPublisherCapture(sessionEpoch, expectedGeneration)) {
    ws.close();
    return;
  }

  if (!adoptSocket(ws, sessionEpoch, expectedGeneration)) return;
  if (!isCurrentPublisherCapture(sessionEpoch, expectedGeneration) || publisherSession.socket !== ws) return;
  publisherReconnectBackoff.noteConnected(performance.now());

  const registration = {
    type: 'register',
    role: 'publisher',
    sampleRate: publisherSession.context.sampleRate,
    captureGeneration: expectedGeneration,
    initialSequence: capturePacketSequence >>> 0,
    audioPacketVersion: AUDIO_PACKET_VERSION,
    // The capture this registration describes already holds a local song.
    premixed: publisherSession.graph?.premixed === true,
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
  audioTransport.bind(ws, { sampleRate: publisherSession.context.sampleRate });
  publisherCommandLiveness.begin(expectedGeneration, performance.now());
  refreshPublisherCommandChannel();
  publisherControlConnections += 1;

  ws.addEventListener('message', (event) => {
    if (publisherSession.socket === ws) publisherCommandLiveness.noteInbound(performance.now());
    if (
      publisherSession.socket !== ws
      || !isCurrentPublisherCapture(sessionEpoch, expectedGeneration)
      || typeof event.data !== 'string'
    ) return;
    handleServerMessage(JSON.parse(event.data), sessionEpoch, expectedGeneration);
  });

  ws.addEventListener('close', () => {
    if (publisherSession.socket !== ws) return;
    publisherReconnectBackoff.noteClosed(performance.now());
    calibrationProbePlayback.cancelPending();
    audioTransport.unbind(ws);
    publisherSession.detachSocket(ws);
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
  const previous = publisherSession.socket;
  if (previous) {
    audioTransport.unbind(previous);
    publisherSession.detachSocket(previous);
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
  return publisherSession.recover(async (snapshot, current) => {
    const { epoch: sessionEpoch, stream } = snapshot;
    let replacement = null;
    let committed = false;
    let timeout;
    try {
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
      if (!publisherSession.replaceContext(snapshot, prepared)) return false;
      committed = true;
      replacement = null;
      prepared.addEventListener('statechange', () => {
        if (!publisherSession.active || publisherSession.context !== prepared) return;
        if (prepared.state === 'closed') {
          void finishMicrophoneSession('context-closed', { releaseMic: false }).catch(console.error);
        } else if (shouldRequestAudioResume(prepared.state)) {
          beginCaptureRecovery(`context-${prepared.state}`);
        }
      });
      const generation = advanceCaptureGeneration('context-clock-underfed');
      if (!isCurrentPublisherCapture(sessionEpoch, generation)) return false;
      if (!installCaptureGraph(sessionEpoch, stream, prepared)) return false;
      micCaptureRecovery.noteGraphRebuilt(captureSnapshot());
      restartPublisherConnectionForGeneration(sessionEpoch, generation);
      startCaptureWatchdog(sessionEpoch, generation);
      console.warn('Microphone AudioContext replaced after sustained clock loss');
      return true;
    } catch (error) {
      console.warn('Microphone AudioContext recovery failed', error);
      // Failed preparation leaves existing capture intact; a committed failure
      // needs the bounded user-gesture Retry Mic path for this session only.
      if (committed && isCurrentPublisherSession(sessionEpoch)) {
        void finishMicrophoneSession('context-rebuild-failed', { releaseMic: false }).catch(console.error);
      }
      return false;
    } finally {
      clearTimeout(timeout);
      if (replacement) void replacement.close().catch(() => {});
    }
  });
}

// Opening or closing a local file changes what the capture carries, and Relay
// mixes a premixed capture at unity. A new capture generation makes that
// switch at a sample boundary: no voice-gain samples are mixed as premixed or
// the other way round.
function syncLocalFileMode() {
  const graph = publisherSession.graph;
  if (!publisherSession.active || !graph || graph.premixed === localFileMix.active) return;
  void rebuildPublisherCaptureGraph('local-file-mode').then((rebuilt) => {
    if (rebuilt) syncLocalFileMode();
  });
}
localFileMix.addEventListener('change', (event) => {
  const kind = event.detail?.kind;
  if (kind === 'mode') syncLocalFileMode();
  // Another file on the same premixed capture: only its name changes for the room.
  if (kind === 'file' && publisherSession.graph?.premixed && publisherSession.socket?.readyState === WebSocket.OPEN) {
    try {
      publisherSession.socket.send(JSON.stringify({ type: 'set-local-file', title: localFileMix.title }));
    } catch {}
  }
});

function rebuildPublisherCaptureGraph(reason) {
  return publisherSession.recover(async (snapshot) => {
    const { epoch: sessionEpoch, context: captureContext, stream: captureStream } = snapshot;
    try {
      if (!publisherSession.dropGraph(snapshot)) return false;
      const generation = advanceCaptureGeneration(reason);
      restartPublisherConnectionForGeneration(sessionEpoch, generation);
      if (!isCurrentPublisherCapture(sessionEpoch, generation)) return false;

      if (!installCaptureGraph(sessionEpoch, captureStream, captureContext)) return false;
      micCaptureRecovery.noteGraphRebuilt(captureSnapshot());
      startCaptureWatchdog(sessionEpoch, generation);
      return true;
    } catch (error) {
      console.warn('Microphone capture graph rebuild failed', error);
      if (isCurrentPublisherSession(sessionEpoch)) {
        // Local source failure preserves server reconnect grace for Retry Mic.
        void finishMicrophoneSession('capture-rebuild-failed', { releaseMic: false }).catch(console.error);
      }
      return false;
    }
  });
}

async function stop({ releaseMic = true } = {}) {
  // Revoke this session before any asynchronous close can yield. Everything
  // after the first await is allowed to touch only captured old resources.
  const retired = publisherSession.retire();
  calibrationProbePlayback.retire();
  clearSocketReconnect();
  stopAudioUplinkHealthReporting();
  stopCaptureWatchdog();
  micCaptureRecovery.stop();
  captureClockRecovery.reset();

  const closing = retired.finish({ releaseMic });
  resetPublisherHealthRequestCorrelation();
  resetPublisherCommandFreshness();
  audioTransport.fallback.setEncodedBitrate(null);
  pendingPublisherTakeoverOwnerId = null;
  publishLocalMicState();

  latestLocalMicLevel = null;
  captureAppliedSettings = null;
  dispatchRelayEvent('relay-local-mic-level', {
    active: false,
    captureGeneration: publisherSession.generation >>> 0,
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

  await closing;
  return retired.epoch;
}

async function startPublisher(takeoverExpectedOwnerId = null) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Microphone capture is unavailable. On a phone, open Relay through HTTPS.');
  }

  const startup = publisherSession.beginStartup();
  publisherButton.disabled = true;
  updateSingerControls();
  pendingPublisherTakeoverOwnerId = takeoverExpectedOwnerId;

  let preparedEncoder = null;
  const ownsEncoder = () => preparedEncoder !== null && publisherSession.active && publisherSession.encoder === preparedEncoder;
  try {
    // Browser permission promises are not abortable on every supported phone.
    // The gate gives the UI a deadline and stops a stream that resolves after
    // this attempt was cancelled or superseded.
    const preparedStream = await micStartup.wait(
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
      preparedEncoder = await micStartup.wait(startup, createMicOpusTrial({
        bitrate: micCodecConfig.bitrate,
        onPacket: packet => {
          if (!ownsEncoder()) return;
          const result = audioTransport.send(packet);
          if (!result.sent) recordUplinkDrop(960, result.reason ?? 'disconnected');
        },
        onDrop: (samples, reason) => { if (ownsEncoder()) recordUplinkDrop(samples, reason); },
        onBitrate: bitrate => { if (ownsEncoder()) audioTransport.fallback.setEncodedBitrate(bitrate); },
        onError: error => {
          const preparing = micStartup.isCurrent(startup);
          if (!preparing && !ownsEncoder()) return;
          console.error('Mic Opus failed', error);
          if (preparing) micStartup.cancel(startup, error);
          else finishMicrophoneSession('opus-failed', { releaseMic: false }).catch(console.error);
        },
      }), { stage: 'preparing compressed microphone audio', dispose: encoder => encoder.close() });
    }
    const preparedContext = micStartup.own(
      startup,
      new AudioContext({ latencyHint: 'interactive', ...(micCodecConfig.opus ? { sampleRate: 48000 } : {}) }),
      context => context.close(),
    );
    if (micCodecConfig.opus && preparedContext.sampleRate !== 48000) throw new Error('Opus trial requires 48 kHz capture');
    const captureContext = preparedContext;
    captureContext.addEventListener('statechange', () => {
      if (!publisherSession.active || publisherSession.context !== captureContext) return;
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

    // Transfer ownership before any active-state event can invoke teardown.
    const sessionEpoch = publisherSession.activate(startup, {
      stream: preparedStream, context: preparedContext, encoder: preparedEncoder,
    });
    if (sessionEpoch === null) throw new MicStartupCancelledError();
    if (publisherSession.encoder) audioTransport.fallback.setEncodedBitrate(publisherSession.encoder.bitrate);
    const captureStream = publisherSession.stream;
    captureAppliedSettings = readCaptureSettings(captureStream);
    publishLocalMicState();
    if (!isCurrentPublisherSession(sessionEpoch)) return;

    // A websocket reconnect keeps this generation. Only a true capture-clock
    // boundary (new Mic session or rebuilt graph) advances it.
    const generation = advanceCaptureGeneration('publisher-start');
    if (!isCurrentPublisherCapture(sessionEpoch, generation)) return;
    publisherControlConnections = 0;
    startAudioUplinkHealthReporting();

    // Track lifetime belongs to the Mic session, not to one graph generation.
    // Rebuilding a stuck worklet must not make later mute/unmute/ended events stale.
    const captureIsCurrent = () => isCurrentPublisherSession(sessionEpoch)
      && publisherSession.stream === captureStream
      && publisherSession.context !== null;
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
          publisherSession.graph
          && rebuildCaptureForInputDeviceChange(publisherSession.graph)
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
    if (!installCaptureGraph(sessionEpoch, captureStream, captureContext)) return;
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
    await micStartup.dispose(startup);
  }
}

async function requestPublisherStart(
  takeoverExpectedOwnerId = null,
  { preserveMicOwnership = false } = {},
) {
  return publisherSession.requestStart(async () => {
    try {
      // A self-owner recovery must replace the damaged local capture without
      // opening a room-ownership race. Ordinary Take Mic/takeover still releases
      // any prior local Mic before acquiring through the normal server path.
      // A retired session finishes its own cleanup independently of a retry.
      if (publisherSession.active || publisherSession.starting) {
        await stop({ releaseMic: !preserveMicOwnership });
      }
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
  });
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
  if (!publisherSession.active) return;

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
  if (!publisherSession.active) return;
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
