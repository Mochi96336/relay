import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import WebSocket from 'ws';

import type { loadRelayConfig } from './config.js';
import { AudioSession, LIMITER_THRESHOLD_DBFS } from './audio-session.js';
import { BackingRuntime } from './backing-runtime.js';
import { SourceRuntime } from './source-runtime.js';
import { loadAudioTransportConfig } from './audio-transport-config.js';
import { parseAudioUplinkHealth } from './audio-uplink-health.js';
import { parseMicPresenceTelemetry } from './mic-presence-telemetry.js';
import { monitorBacklogBudgetBytes } from './monitor-backpressure.js';
import { combineBootCalibration } from './boot-calibration.js';
import { BootProbeRuntime } from './boot-probe-runtime.js';
import { locateProbe, PROBE_REFERENCE_MS } from './calibration-probe.js';
import { CalibrationSession, type CalibrationContext } from './calibration-session.js';
import { ContentCalibrationValidator } from './content-calibration-validator.js';
import { analyzeTimingCalibrationInWorker } from './timing-calibration-worker-client.js';
import { applyMicOwnerTransitionEffects } from './mic-owner-transition-application.js';
import { MicRuntime } from './mic-runtime.js';
import { MicTransportGraceRuntime } from './mic-transport-grace-runtime.js';
import { TimingRuntime } from './timing-runtime.js';
import { buildRelayObservationStatusV1 } from './observation-status.js';
import { authorizeMicOwnerCommand, type MicOwnerCommand } from './command-authority.js';
import { decodePcmFrame, type PcmFrame } from './pcm-frame.js';
import type { ProbeTarget } from './probe-lifecycle.js';
import { buildProductViewModel } from './product-view-model.js';
import { buildReadiness } from './readiness.js';
import { deriveRemoteStatusHealth } from './remote-status.js';
import { createRelayHttpServer } from './relay-http-server.js';
import { createRelayQueryProtocol } from './relay-query-protocol.js';
import { createRelayCommandProtocol } from './relay-command-protocol.js';
import { createRelayInfrastructureEventProtocol } from './relay-infrastructure-event-protocol.js';
import { createRelayAuthenticationProtocol } from './relay-authentication-protocol.js';
import { createRelayRegistrationProtocol } from './relay-registration-protocol.js';
import { createRelayPublisherActivationCoordinator } from './relay-publisher-activation-coordinator.js';
import { createRelayMicReleaseCoordinator } from './relay-mic-release-coordinator.js';
import { createRelayBackingActivationCoordinator } from './relay-backing-activation-coordinator.js';
import { createRelayRobotLifecycleProtocol } from './relay-robot-lifecycle-protocol.js';
import { createRelayRobotActivationCoordinator } from './relay-robot-activation-coordinator.js';
import { createRelayRobotDisconnectCoordinator } from './relay-robot-disconnect-coordinator.js';
import { createRelayMicDisconnectCoordinator } from './relay-mic-disconnect-coordinator.js';
import { createRelayBackingDisconnectCoordinator } from './relay-backing-disconnect-coordinator.js';
import { createRelayAudioUplinkCoordinator } from './relay-audio-uplink-coordinator.js';
import { createRelayLiveSourceStopCoordinator } from './relay-live-source-stop-coordinator.js';
import { createRelayMicTimingInvalidationCoordinator } from './relay-mic-timing-invalidation-coordinator.js';
import { createRelayMicCaptureRestartCoordinator } from './relay-mic-capture-restart-coordinator.js';
import { createRelayBackingCaptureRestartCoordinator } from './relay-backing-capture-restart-coordinator.js';
import { createRelayManualBootRecalibrationCoordinator } from './relay-manual-boot-recalibration-coordinator.js';
import { createRelayTakeCommandCoordinator } from './relay-take-command-coordinator.js';
import { createRelayYoutubeTelemetryAcceptanceCoordinator } from './relay-youtube-telemetry-acceptance-coordinator.js';
import {
  createMonitorSocketTransport,
  createRelaySocketTransport,
  createRelayWebSocketServer,
  type RelaySocket,
} from './relay-socket-server.js';
import { RobotPlayerOffsetTracker } from './robot-player-offset.js';
import { RobotContentTimelineMapper } from './robot-content-timeline.js';
import { RobotContentTransitionRuntime } from './robot-content-transition-runtime.js';
import {
  ParticipantSession,
  normalizeParticipantId,
} from './participant-session.js';
import { legacyTestParticipantIdentityEnabled } from './participant-capability.js';
import {
  participantIdentityFromAuthentication,
  participantIdentityFromUpgradeRequest,
  type ParticipantIdentityResult,
} from './participant-identity.js';
import { PlaybackTransportRuntime } from './playback-transport-runtime.js';
import { createRelayPlaybackDisconnectCoordinator } from './relay-playback-disconnect-coordinator.js';
import { InfrastructureCapabilityRuntime } from './infrastructure-capability-runtime.js';
import { parseRoomSongCommand } from './room-song-command.js';
import type { AcceptedRoomSongCommand } from './room-song-command-session.js';
import { RoomSongCommandRuntime } from './room-song-command-runtime.js';
import {
  LEGACY_PLAYBACK_PARTICIPANT_ID,
  LEGACY_PLAYBACK_TRANSPORT_ID,
  SongSession,
  normalizePlaybackGeneration,
  normalizePlaybackTransportId,
  type PlaybackIdentity,
  type SongHandoffPlan,
} from './song-session.js';
import { takeFrameBoundaryAtOrAfter } from './take-boundary.js';
import { TakeController, type TakeSongSnapshot } from './take-controller.js';
import { takeSongSnapshotFromRoom } from './take-song-snapshot.js';
import { SERVER_INCARNATION } from './server-incarnation.js';
import {
  WebTransportMediaRuntime,
  webTransportMediaConfig,
} from './webtransport-media-server.js';

type RelayConfig = ReturnType<typeof loadRelayConfig>;

export async function startRelayServer(relayConfig: RelayConfig) {
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../public');
const takeDir = path.resolve(relayConfig.takeDir);
const port = relayConfig.port;
const relayKey = relayConfig.relayKey;

const MIX_SAMPLE_RATE = 48_000;
const MIX_FRAME_MS = 20;
const MONITOR_BACKLOG_MS = relayConfig.monitorBacklogMs;
const MONITOR_BACKLOG_BYTES = monitorBacklogBudgetBytes(MIX_SAMPLE_RATE, MONITOR_BACKLOG_MS);
const LIVE_MIX_PREBUFFER_MS = relayConfig.livePrebufferMs;
const LIVE_BACKING_GAIN = 0.65;
const MAX_OFFSET_MS = 500;
const MIC_RETENTION_MS = relayConfig.micRetentionMs;
/**
 * How far either side of the estimated position a probe is searched for.
 *
 * This bounds the latency a probe can find at all, so it has to cover the
 * whole plausible range of a path rather than just the round-trip estimate's
 * error. The robot's browser-to-PipeWire path measured close to two seconds,
 * which a 400 ms window would have silently missed.
 */
const PROBE_SEARCH_MARGIN_MS = relayConfig.probeSearchMarginMs;
/**
 * Captured-song history kept, sized by the probe rather than by the mixer.
 *
 * The mixer reads the song at the read head and would be happy with a second.
 * The probe analysis is the demanding reader: it waits for the timeline to
 * cover its whole search window and only then looks back across it, so every
 * sample it will examine has to still be there. A hardcoded second was enough
 * only while the backing path was two seconds slow and the probe landed near
 * the frontier; bounding the capture latency moved it back into the discarded
 * region, and the leg started correlating at -1 against a window of zeros.
 */
const BACKING_RETENTION_MS = PROBE_SEARCH_MARGIN_MS + PROBE_REFERENCE_MS + 2_000;
const TIMING_CALIBRATION_MS = 6_000;
const TIMING_CALIBRATION_TIMEOUT_MS = relayConfig.calibrationTimeoutMs;
const MAX_VOCAL_FINE_TUNE_MS = 100;
const MAX_MIC_GAIN_DB = 40;
const MAX_RECOMMENDED_MIC_GAIN_DB = 36;
const FIXED_SONG_LEVEL = 100;
const HEARTBEAT_MS = relayConfig.heartbeatMs;
const MIX_HEALTH_INTERVAL_MS = 1_000;
const PARTICIPANT_GRACE_MS = relayConfig.participantGraceMs;
const MIC_TRANSPORT_GRACE_MS = relayConfig.micTransportGraceMs;
const BACKING_GRACE_MS = relayConfig.backingGraceMs;
const MIC_FIRST_FRAME_TIMEOUT_MS = relayConfig.micFirstFrameTimeoutMs;
const AUDIO_TRANSPORT_CONFIG = loadAudioTransportConfig();
const PLAYBACK_MIC_INTENT_MS = 10_000;
const TAKE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const server = createRelayHttpServer({
  publicDir,
  takeDir,
  relayKey,
  remoteStatus: () => remoteStatusPayload(),
  observationStatusV1: () => observationStatusV1Payload(),
  readiness: () => readinessPayload(),
});
const wss = createRelayWebSocketServer(server, {
  relayKey,
  heartbeatMs: HEARTBEAT_MS,
});
const {
  sendJson,
  broadcastJson,
  canClaimSocketRole,
  commitSocketRole,
} = createRelaySocketTransport(wss);
const monitorTransport = createMonitorSocketTransport(wss, {
  backlogBytes: MONITOR_BACKLOG_BYTES,
});
const infrastructureCapability = new InfrastructureCapabilityRuntime<RelaySocket>({
  key: relayConfig.infrastructureKey,
  legacyAuthorized: relayConfig.legacyTestInfrastructure,
});
const playbackTransport = new PlaybackTransportRuntime<RelaySocket>({
  clients: () => Array.from(wss.clients, (client) => client as RelaySocket),
  isOpen: (socket) => socket.readyState === WebSocket.OPEN,
  send: (socket, payload) => sendJson(socket, payload),
  micIntentMs: PLAYBACK_MIC_INTENT_MS,
});
const participants = new ParticipantSession(PARTICIPANT_GRACE_MS);
const youtubeTimeline = new SongSession();
const roomSongCommands = new RoomSongCommandRuntime();

type TimelineStatus = {
  connected?: boolean;
  videoId?: string;
  state?: number;
  serverTime?: number;
  playbackRate?: number;
  transportEstimateMs?: number;
};

const webTransportMedia = new WebTransportMediaRuntime();
const songLevel = FIXED_SONG_LEVEL;
let lastMixHealthAt = 0;

const session = new AudioSession({
  sampleRate: MIX_SAMPLE_RATE,
  frameMs: MIX_FRAME_MS,
  prebufferMs: LIVE_MIX_PREBUFFER_MS,
  backingGain: LIVE_BACKING_GAIN,
  retentionMs: MIC_RETENTION_MS,
  // Sized by its hungriest reader rather than by the mixer, which needs almost
  // none of it. The probe analysis cannot run until the timeline covers its
  // whole search window, so anything it will look at has to survive that wait.
  backingRetentionMs: BACKING_RETENTION_MS,
});

const takeController = new TakeController({
  directory: takeDir,
  sampleRate: MIX_SAMPLE_RATE,
  onChange: (status) => broadcastJson(status),
});

const sourceRuntime = new SourceRuntime<RelaySocket>({
  isConnected: (socket) => socket.readyState === WebSocket.OPEN,
});
const AUTO_CALIBRATE = relayConfig.autoCalibrate;
const AUTO_CALIBRATION_RETRY_MS = relayConfig.autoCalibrationRetryMs;
const CALIBRATION_AGREEMENT = relayConfig.calibrationAgreement;
const CALIBRATION_TOLERANCE_MS = relayConfig.calibrationToleranceMs;
const CALIBRATION_PROVISIONAL_CONFIDENCE = relayConfig.calibrationProvisionalConfidence;
const CALIBRATION_MAX_LAG_MS = relayConfig.calibrationMaxLagMs;
const CONTENT_VALIDATION_ENABLED = relayConfig.contentValidation;
const CONTENT_VALIDATION_INTERVAL_MS = relayConfig.contentValidationIntervalMs;
const CONTENT_VALIDATION_RETRY_MS = relayConfig.contentValidationRetryMs;
const CONTENT_VALIDATION_DEVIATION_MS = relayConfig.contentValidationDeviationMs;
const timingRuntime = new TimingRuntime({
  autoCalibrationRetryMs: AUTO_CALIBRATION_RETRY_MS,
});

const PROBE_CALIBRATE = relayConfig.probeCalibrate;
const PROBE_RETRY_MS = relayConfig.probeRetryMs;
const PROBE_LEAD_MS = relayConfig.probeLeadMs;
const PROBE_MIN_CORRELATION = relayConfig.probeMinCorrelation;
const PROBE_DEBUG = relayConfig.probeDebug;
const PROBE_REPLY_TIMEOUT_MS = relayConfig.probeReplyTimeoutMs;
const PROBE_MAX_ATTEMPTS = relayConfig.probeMaxAttempts;
/**
 * Long enough for the probe to play, be captured and reach the server.
 *
 * Derived from the search window rather than set independently: the analysis
 * cannot run until the timeline has covered its whole window, so a timeout
 * shorter than that rejects every probe before it is even looked at. Raising
 * `RELAY_CALIBRATION_PROBE_SEARCH_MARGIN_MS` to 10 s did exactly that, and the
 * only symptom was every leg reporting `analysis dropped ... timedOut=true`.
 */
const PROBE_ANALYSIS_TIMEOUT_MS = Math.max(
  relayConfig.probeAnalysisTimeoutMs,
  PROBE_SEARCH_MARGIN_MS + PROBE_REFERENCE_MS + 5_000,
);

const bootProbeRuntime = new BootProbeRuntime({
  maxAttempts: PROBE_MAX_ATTEMPTS,
  retryMs: PROBE_RETRY_MS,
});
const BOOT_DELTA_REAPPLY_MS = relayConfig.calibrationDeltaReapplyMs;
const ROBOT_OFFSET_FRESH_MS = 2_000;
const ROBOT_OFFSET_WINDOW_MS = relayConfig.robotOffsetWindowMs;
const robotPlayerOffset = new RobotPlayerOffsetTracker({
  freshForMs: ROBOT_OFFSET_FRESH_MS,
  windowMs: ROBOT_OFFSET_WINDOW_MS,
});
const robotContentTimeline = new RobotContentTimelineMapper({
  sampleRate: MIX_SAMPLE_RATE,
  freshForMs: ROBOT_OFFSET_FRESH_MS,
});
const ROBOT_CONTENT_TRANSITION_HISTORY_SAMPLES = Math.round(MIX_SAMPLE_RATE * 3);
const ROBOT_CONTENT_TRANSITION_WINDOW_SAMPLES = Math.round(MIX_SAMPLE_RATE * 0.65);
const ROBOT_CONTENT_TRANSITION_LIFETIME_MS = relayConfig.robotContentTransitionLifetimeMs;
const ROBOT_CONTENT_TRANSITION_MAX_WINDOWS = relayConfig.robotContentTransitionMaxWindows;
const ROBOT_CONTENT_TRANSITION_MAX_WORKER_FAILURES = relayConfig.robotContentTransitionMaxWorkerFailures;
const ROBOT_CONTENT_TRANSITION_BOUNDS_CONFIG = {
  lifetimeMs: ROBOT_CONTENT_TRANSITION_LIFETIME_MS,
  maxWindows: ROBOT_CONTENT_TRANSITION_MAX_WINDOWS,
  maxWorkerFailures: ROBOT_CONTENT_TRANSITION_MAX_WORKER_FAILURES,
};

const robotContentTransitionRuntime = new RobotContentTransitionRuntime({
  sampleRate: MIX_SAMPLE_RATE,
  historySamples: ROBOT_CONTENT_TRANSITION_HISTORY_SAMPLES,
  windowSamples: ROBOT_CONTENT_TRANSITION_WINDOW_SAMPLES,
  maxLagMs: CALIBRATION_MAX_LAG_MS,
  toleranceMs: CALIBRATION_TOLERANCE_MS,
  retentionSamples: BACKING_RETENTION_MS * MIX_SAMPLE_RATE / 1_000,
  bounds: ROBOT_CONTENT_TRANSITION_BOUNDS_CONFIG,
  host: {
    context: calibrationContext,
    currentDeltaMs: () => robotContentTimeline.currentDeltaMs,
    backingTotalSamples: () => session.backingTotalSamples,
    micTotalSamples: () => session.micTotalSamples,
    readBacking: (start, length) => session.readBacking(start, length),
    readMic: (start, length) => session.readMic(start, length),
    transitionEvidence: (maxSamples) => calibration.transitionEvidence(maxSamples),
    commit: (plan, nowMs) => {
      if (!robotContentTimeline.noteBackingBoundary(plan.boundarySample, plan.context, nowMs)) return false;
      if (plan.discardWorkingEvidence) {
        // Unclassifiable media-transition PCM is not capture loss. Do not zero-fill
        // it into a six-second analysis window; restart only unanalysed evidence.
        calibration.restartWorkingEvidence(nowMs);
        if (contentCalibrationValidator.collecting) contentCalibrationValidator.cancel(nowMs);
      }

      for (const chunk of plan.confirmedPreChunks) {
        feedContentBackingEvidence(chunk.samples, chunk.start, nowMs);
      }
      for (const chunk of plan.postChunks) {
        const mapped = robotContentTimeline.mapBackingStart(chunk.start, plan.context, nowMs);
        if (mapped !== null) feedContentBackingEvidence(chunk.samples, mapped, nowMs);
      }
      return true;
    },
    onDegraded: (status) => {
      console.warn(
        '[robot-content-transition] degraded fail-closed:'
        + ` reason=${status.degradedReason ?? 'unknown'}`
        + ` windows=${status.windowsStarted}/${status.maxWindows}`
        + ` workerFailures=${status.workerFailures}/${status.maxWorkerFailures}`
        + ` ageMs=${status.ageMs}`,
      );
      broadcastJson(timingCalibrationStatusPayload());
    },
  },
});

const STREAM_LIVE_MS = 1_000;
const COLLECTION_SILENCE_GRACE_MS = 1_500;

const backingRuntime = new BackingRuntime<RelaySocket>({
  graceMs: BACKING_GRACE_MS,
  isConnected: (socket) => socket.readyState === WebSocket.OPEN,
  onGraceExpired: expireBackingGrace,
});

const micRuntime = new MicRuntime({
  audioTransportConfig: AUDIO_TRANSPORT_CONFIG,
  firstFrameTimeoutMs: MIC_FIRST_FRAME_TIMEOUT_MS,
  streamLiveMs: STREAM_LIVE_MS,
  createDirectMediaTicket: () => webTransportMedia.createTicket(),
  directMediaConnected: (ticket) => webTransportMedia.hasSession(ticket),
  offerDirectMedia: (ticket) => webTransportMedia.offer(ticket),
});

const micTransportGrace = new MicTransportGraceRuntime({
  graceMs: MIC_TRANSPORT_GRACE_MS,
  onExpired: expireMicTransportGrace,
});

function noteMicFrame(nowMs: number) {
  micRuntime.noteFrame(nowMs);
}

function micFlowObserved() {
  return micRuntime.flowObserved();
}

function micStartupTimedOut(nowMs = performance.now()) {
  return micRuntime.startupTimedOut(nowMs);
}

function micStreaming(nowMs = performance.now()) {
  return micRuntime.streaming(nowMs);
}

function bothStreamsFlowing(nowMs: number) {
  return silentSides(nowMs).length === 0;
}

function silentSides(nowMs: number) {
  const silent: string[] = [];
  if (!micStreaming(nowMs)) silent.push('phone microphone');
  if (!backingRuntime.streaming(nowMs, STREAM_LIVE_MS)) silent.push('desktop capture');
  return silent;
}

function webTransportMicConnected() {
  return micRuntime.directMediaConnected();
}

function micMediaConnected() {
  return micRuntime.connected();
}

function micMediaPath() {
  return micRuntime.mediaPath();
}

function clearMicMediaAuthority() {
  micRuntime.clearMediaAuthority(performance.now());
  session.setMicExpected(false);
}

function expireMicTransportGrace(expectedOwnerId: string) {
  if (participants.micOwnerId !== expectedOwnerId) return;
  if (
    micRuntime.controlConnected()
    && micRuntime.publisher?.participantId === expectedOwnerId
  ) return;

  const directMediaStillFlowing = micRuntime.mediaOwnerId === expectedOwnerId
    && webTransportMicConnected()
    && micStreaming(performance.now());
  if (directMediaStillFlowing) {
    // Control-plane loss must not revoke a Mic whose independent media plane
    // is still carrying the same capture. Keep checking until control returns
    // or the direct media path actually stops carrying fresh PCM.
    micTransportGrace.schedule(expectedOwnerId);
    return;
  }

  const released = participants.releaseMic(expectedOwnerId, 'transport-expired');
  if (!released.ok) return;
  clearMicMediaAuthority();
  applyMicOwnerEffects(released.effects);
  broadcastSessionStatus();
}

function calibrationContext(): CalibrationContext {
  return {
    sessionGeneration: session.generation,
    micGeneration: session.micGeneration,
    backingGeneration: session.backingGeneration,
    sourceGeneration: sourceRuntime.generation,
  };
}

function robotProbeTimingActive() {
  return PROBE_CALIBRATE && (
    backingRuntime.isRobot
    || sourceRuntime.connected()
  );
}

/** The current Robot route has spent its bounded probe attempts. */
function probeCalibrationExhausted(nowMs = performance.now()) {
  return robotProbeTimingActive() && probeStatus(nowMs).error !== null;
}

function robotContentFallbackPrimingActive(nowMs = performance.now()) {
  if (
    !AUTO_CALIBRATE
    || takeBlocksCalibration()
    || !robotProbeTimingActive()
    || probeCalibrationExhausted(nowMs)
    || !robotContentMappingReady(nowMs)
  ) return false;
  const timeline = currentTimelineStatus(nowMs);
  return Boolean(timeline.connected) && Number(timeline.state) === 1;
}

function robotDeltaIsFresh(nowMs = performance.now()) {
  return sourceRuntime.connected()
    && robotPlayerOffset.offsetMs(nowMs) !== null
    && robotPlayerOffset.isFresh(nowMs);
}

function robotContentMappingReady(nowMs = performance.now()) {
  if (!robotProbeTimingActive()) return true;
  return sourceRuntime.connected()
    && robotContentTimeline.isReady(calibrationContext(), nowMs);
}

function mappedContentBackingStart(startSample: number, nowMs = performance.now()) {
  if (!backingRuntime.isRobot) return startSample;
  return robotContentTimeline.mapBackingStart(startSample, calibrationContext(), nowMs);
}

function clearRobotContentTransition() {
  robotContentTransitionRuntime.clear();
}

function robotContentTransitionStatus(nowMs = performance.now()) {
  return robotContentTransitionRuntime.status(nowMs);
}

function sweepRobotContentTransition(nowMs: number) {
  return robotContentTransitionRuntime.sweep(nowMs);
}

function clearRobotBackingBoundaryRequest() {
  robotContentTransitionRuntime.clear();
}

function feedContentBackingEvidence(samples: Int16Array, start: number, nowMs: number) {
  if (samples.length === 0) return;
  if (robotContentFallbackPrimingActive(nowMs)) {
    calibration.primeBacking(samples, start);
  }
  calibration.observeBacking(samples, start);
  contentCalibrationValidator.observeBacking(samples, start);
}

function beginRobotContentTransition(
  fromMediaTime: number,
  toMediaTime: number,
  preDeltaMs: number,
  referenceDeltaMs: number,
  context: CalibrationContext,
  nowMs = performance.now(),
) {
  const confirmedReferenceLagMs = timingRuntime.calibrationKind === 'content'
    ? calibration.confirmedResult?.micLagMs ?? null
    : null;
  robotContentTransitionRuntime.begin({
    fromMediaTime,
    toMediaTime,
    preDeltaMs,
    referenceDeltaMs,
    context,
    confirmedReferenceLagMs,
  }, nowMs);
}

function reconcileRobotContentTransitionWithFreshDelta(
  context: CalibrationContext,
  nowMs = performance.now(),
) {
  const confirmedReferenceLagMs = timingRuntime.calibrationKind === 'content'
    ? calibration.confirmedResult?.micLagMs ?? null
    : null;
  return robotContentTransitionRuntime.reconcileWithFreshDelta({
    context,
    committedDeltaMs: robotContentTimeline.committedDeltaMs,
    freshDeltaMs: robotContentTimeline.currentDeltaMs,
    referenceDeltaMs: robotContentTimeline.referenceDeltaMs,
    confirmedReferenceLagMs,
  }, nowMs);
}

function noteRobotTransitionBackingFrame(
  frame: PcmFrame,
  samples: Int16Array,
  start: number,
  nowMs: number,
) {
  robotContentTransitionRuntime.noteBackingFrame({
    frameGeneration: frame.generation,
    firstSampleIndex: frame.firstSampleIndex,
    sourceSampleCount: Math.floor(frame.pcm.byteLength / 2),
    sourceSampleRate: backingRuntime.sampleRate,
    samples,
    start,
    backingTotalSamples: session.backingTotalSamples,
  }, nowMs);
}

function requestRobotBackingBoundary(nowMs = performance.now()) {
  const context = calibrationContext();
  if (!robotContentTimeline.needsBackingBoundary(context)) return false;
  if (!reconcileRobotContentTransitionWithFreshDelta(context, nowMs)) return false;
  const target = backingRuntime.socket;
  const backingGeneration = session.backingGeneration;
  if (
    !backingRuntime.isRobot
    || target?.readyState !== WebSocket.OPEN
    || backingGeneration === null
  ) return false;

  const request = robotContentTransitionRuntime.requestBackingBoundary(backingGeneration);
  if (request === null) return false;
  sendJson(target, {
    type: 'backing-sample-boundary-request',
    requestId: request.requestId,
  });
  return true;
}

const calibration = new CalibrationSession({
  sampleRate: MIX_SAMPLE_RATE,
  durationMs: TIMING_CALIBRATION_MS,
  timeoutMs: TIMING_CALIBRATION_TIMEOUT_MS,
  context: calibrationContext,
  agreementWindows: CALIBRATION_AGREEMENT,
  agreementToleranceMs: CALIBRATION_TOLERANCE_MS,
  provisionalConfidence: CALIBRATION_PROVISIONAL_CONFIDENCE,
  maxLagMs: CALIBRATION_MAX_LAG_MS,
  analyze: analyzeTimingCalibrationInWorker,
  onSettled: () => {
    syncAppliedCalibration();
    broadcastJson(timingCalibrationStatusPayload());
    broadcastJson(sourceStatusPayload());
  },
});

const contentCalibrationValidator = new ContentCalibrationValidator({
  sampleRate: MIX_SAMPLE_RATE,
  durationMs: TIMING_CALIBRATION_MS,
  timeoutMs: TIMING_CALIBRATION_TIMEOUT_MS,
  intervalMs: CONTENT_VALIDATION_INTERVAL_MS,
  retryMs: CONTENT_VALIDATION_RETRY_MS,
  deviationThresholdMs: CONTENT_VALIDATION_DEVIATION_MS,
  agreementToleranceMs: CALIBRATION_TOLERANCE_MS,
  context: calibrationContext,
  enabled: CONTENT_VALIDATION_ENABLED,
  maxLagMs: CALIBRATION_MAX_LAG_MS,
  analyze: analyzeTimingCalibrationInWorker,
  onChange: () => {
    broadcastJson(timingCalibrationStatusPayload());
  },
  onDriftConfirmed: (result) => {
    timingRuntime.markContentAuthority();
    // applyValidatedResult synchronously calls onSettled -> syncAppliedCalibration.
    // Mark that revision first so only this runtime promotion takes the slew path.
    timingRuntime.prepareContentValidationSlew(calibration.confirmedRevision + 1);
    calibration.applyValidatedResult(result);
    // applyValidatedResult increments synchronously. Keep the validator's
    // own drift-confirmed state rather than immediately reseeding it.
    timingRuntime.markContentValidationBaseline(calibration.confirmedRevision);
  },
});

function clearContentValidationBaseline() {
  timingRuntime.clearContentValidationBaseline();
  contentCalibrationValidator.clearBaseline();
}

function syncContentValidationBaseline(nowMs: number) {
  const confirmed = calibration.confirmedResult;
  if (
    timingRuntime.calibrationKind !== 'content'
    || confirmed === null
    || calibrationIsStale()
  ) {
    if (contentCalibrationValidator.hasBaseline) clearContentValidationBaseline();
    return;
  }

  if (
    timingRuntime.contentValidationBaselineRevision === calibration.confirmedRevision
    && contentCalibrationValidator.hasBaseline
  ) return;

  contentCalibrationValidator.setBaseline({
    micLagMs: confirmed.micLagMs,
    confidence: confirmed.confidence,
    segmentLagsMs: confirmed.segmentLagsMs,
    context: calibrationContext(),
  }, nowMs);
  timingRuntime.markContentValidationBaseline(calibration.confirmedRevision);
}

function cancelActiveContentValidation(nowMs = performance.now()) {
  const state = contentCalibrationValidator.status(nowMs).state;
  if (!contentCalibrationValidator.collecting && state !== 'suspect') return false;
  contentCalibrationValidator.cancel(nowMs);
  return true;
}

function rejectInfrastructure(socket: RelaySocket, message: string) {
  sendJson(socket, { type: 'infrastructure-auth-rejected', message });
  socket.close(1008, 'Infrastructure authentication required.');
}

function attachParticipantIdentity(
  socket: RelaySocket,
  identity: Extract<ParticipantIdentityResult, { kind: 'valid' }>,
) {
  if (infrastructureCapability.authenticated(socket)) return false;
  if (socket.participantId) return socket.participantId === identity.participantId;
  socket.participantId = identity.participantId;
  socket.participantConnectionId = `connection-${socket.connectionIncarnation}`;
  const changed = participants.attach({
    connectionId: socket.participantConnectionId,
    participantId: identity.participantId,
    nickname: identity.nickname,
    nowMs: Date.now(),
  });
  if (changed) broadcastSessionStatus();
  else sendJson(socket, sessionStatusPayload());
  return true;
}

function sessionStatusPayload() {
  const snapshot = participants.snapshot();
  const ownerId = snapshot.micOwnerId;
  return {
    type: 'session-status',
    ...snapshot,
    // Presence reports whether the owner's Mic media is available. The control
    // WebSocket can reconnect independently while WebTransport keeps PCM live.
    micConnected: ownerId !== null
      && micRuntime.mediaOwnerId === ownerId
      && micMediaConnected(),
  };
}

function broadcastSessionStatus() {
  broadcastJson(sessionStatusPayload());
}

function participantPayload(participantId: string | null) {
  return participantId ? participants.participant(participantId) : null;
}

function requireMicOwnerCommand(socket: RelaySocket, command: MicOwnerCommand) {
  const decision = authorizeMicOwnerCommand(
    {
      participantId: socket.participantId ?? null,
      isCurrentPublisher: micRuntime.isPublisher(socket),
    },
    participants.micOwnerId,
  );
  if (decision.ok) return true;

  sendJson(socket, {
    type: 'command-rejected',
    command,
    reason: decision.reason,
    owner: participantPayload(participants.micOwnerId),
    revision: participants.revision,
  });
  return false;
}

function roomSongCommandStatusPayload(nowMs = performance.now()) {
  return {
    ...roomSongCommands.statusPayload(nowMs),
    serverIncarnation: SERVER_INCARNATION,
  };
}

function roomSongCommandApplyPayload(command: AcceptedRoomSongCommand) {
  return {
    type: 'room-song-command-apply',
    commandId: command.commandId,
    revision: command.revision,
    supersedesCommandId: command.supersedesCommandId,
    issuedByParticipantId: command.issuedByParticipantId,
    targetPlaybackTransportId: command.target.transportId,
    targetPlaybackGeneration: command.target.generation,
    ...command.body,
  };
}

function rejectRoomSongCommand(socket: RelaySocket, commandId: unknown, reason: string) {
  sendJson(socket, {
    type: 'room-song-command-rejected',
    commandId: typeof commandId === 'string' ? commandId : null,
    reason,
    revision: roomSongCommands.revision,
    room: youtubeTimeline.roomStatusPayload(),
  });
}

function broadcastRoomSongCommandFailure(
  commandId: string,
  reason: string,
  nowMs = performance.now(),
) {
  broadcastJson({
    type: 'room-song-command-failed-ack',
    commandId,
    revision: roomSongCommands.revision,
    reason,
    room: youtubeTimeline.roomStatusPayload(nowMs),
  });
}

function cancelPendingRoomSongCommand(reason: string, nowMs = performance.now()) {
  const cancelled = roomSongCommands.cancelPending();
  if (!cancelled) return false;
  broadcastRoomSongCommandFailure(cancelled.commandId, reason, nowMs);
  broadcastJson(roomSongCommandStatusPayload(nowMs));
  return true;
}

function takeSongSnapshot(nowMs = performance.now()): TakeSongSnapshot {
  return takeSongSnapshotFromRoom(
    youtubeTimeline.roomStatusPayload(nowMs) as Record<string, unknown>,
  );
}

function takeFrameBoundary(nowMs = performance.now()) {
  return takeFrameBoundaryAtOrAfter({
    generation: session.generation,
    sessionSampleIndex: session.sessionSampleAt(nowMs),
    frameSamples: session.frameSamples,
    sampleRate: session.sampleRate,
    nowMs,
  });
}

function rejectTakeCommand(socket: RelaySocket, command: 'start' | 'stop', reason: string) {
  sendJson(socket, {
    type: 'take-command-rejected',
    command,
    reason,
  });
}

function handoffPayload(type: 'song-handoff-prepare' | 'song-handoff-commit', plan: SongHandoffPlan) {
  return {
    type,
    handoffId: plan.handoffId,
    revision: plan.revision,
    videoId: plan.videoId,
    state: plan.state,
    serverTime: plan.serverTime,
    playbackRate: plan.playbackRate,
  };
}

function sendHandoffPlan(type: 'song-handoff-prepare' | 'song-handoff-commit', plan: SongHandoffPlan) {
  return playbackTransport.send(plan.target, handoffPayload(type, plan));
}

/**
 * Ends a handoff that has stopped being able to complete.
 *
 * A live handoff intentionally holds the room song still, so it must not be
 * able to outlive the transport it is waiting for. A page reload also lands
 * here rather than resuming: the playback generation changes on load, so the
 * reloaded tab is a different transport and the prepared target is genuinely
 * gone.
 */
function sweepPreparedSongHandoff(nowMs: number) {
  const target = youtubeTimeline.handoffTarget();
  if (!target) return false;
  if (!youtubeTimeline.sweepHandoff(
    playbackTransport.connected(target),
    nowMs,
    participants.micOwnerId,
  )) return false;

  playbackTransport.send(target, { type: 'song-handoff-cancelled' });
  broadcastJson(youtubeTimeline.statusPayload(nowMs));
  broadcastJson(youtubeTimeline.roomStatusPayload(nowMs));
  return true;
}

function beginPreparedSongHandoff(participantId: string, nowMs = performance.now()) {
  const target = playbackTransport.selectHandoffTarget(participantId, nowMs);
  if (!target) return false;
  const plan = youtubeTimeline.beginHandoff(target, participants.micOwnerId, nowMs);
  if (!plan) return false;
  sendHandoffPlan('song-handoff-prepare', plan);
  broadcastJson(youtubeTimeline.statusPayload(nowMs));
  broadcastJson(youtubeTimeline.roomStatusPayload(nowMs));
  return true;
}

function applyMicOwnerEffects(
  effects: Parameters<typeof applyMicOwnerTransitionEffects>[0],
  nowMs = performance.now(),
  options: {
    afterQualityEvent?: () => void;
    beforeTimingInvalidation?: () => void;
    publishFullHandoffStatus?: boolean;
    invalidateTiming?: (reason: string) => void;
    prepareSongHandoff?: (participantId: string) => void;
  } = {},
) {
  if (effects.changed) youtubeTimeline.retireFailedHandoffHoldover();
  return applyMicOwnerTransitionEffects(effects, {
    noteQualityEvent: (event) => {
      takeController.noteQualityEvent(event);
      options.afterQualityEvent?.();
    },
    cancelRoomSongCommand: (reason) => cancelPendingRoomSongCommand(reason, nowMs),
    cancelSongHandoff: () => youtubeTimeline.cancelHandoff(),
    publishSongHandoffCancellation: () => {
      if (options.publishFullHandoffStatus !== false) {
        broadcastJson(youtubeTimeline.statusPayload(nowMs));
      }
      broadcastJson(youtubeTimeline.roomStatusPayload(nowMs));
    },
    invalidateTiming: (reason) => {
      options.beforeTimingInvalidation?.();
      if (options.invalidateTiming) options.invalidateTiming(reason);
      else invalidateMicTiming(reason);
    },
    prepareSongHandoff: (participantId) => {
      if (options.prepareSongHandoff) options.prepareSongHandoff(participantId);
      else beginPreparedSongHandoff(participantId, nowMs);
    },
  });
}

/**
 * Tells a playback page why its telemetry is being ignored.
 *
 * Rejection used to be a bare `return`, which is indistinguishable from a lost
 * connection: the page keeps sending several times a second and its server
 * timeline readout simply never advances. Telemetry is far too frequent to
 * answer every time, so only a *change* of reason is reported, and an accepted
 * packet clears the memory so the next problem is reported again.
 */
/**
 * The same discipline for the room-command gate's refusals.
 *
 * Shares `telemetryRejectedReason` with the authority refusals above so that
 * switching between the two kinds still notifies, and one accepted packet
 * clears both.
 */
function reportRoomSongTelemetryRejected(socket: RelaySocket, reason: string) {
  const key = `room-song:${reason}`;
  if (socket.telemetryRejectedReason === key) return;
  socket.telemetryRejectedReason = key;
  sendJson(socket, {
    type: 'room-song-telemetry-rejected',
    reason,
    revision: roomSongCommands.revision,
  });
}

function reportTelemetryRejected(socket: RelaySocket, reason: string) {
  if (socket.telemetryRejectedReason === reason) return;
  socket.telemetryRejectedReason = reason;
  sendJson(socket, {
    type: 'youtube-telemetry-rejected',
    reason,
    playbackLeaderParticipantId: youtubeTimeline.statusPayload().playbackLeaderParticipantId,
    micOwner: participantPayload(participants.micOwnerId),
  });
}

function replacePrevious(previous: RelaySocket | null, next: RelaySocket, message: string) {
  if (!previous || previous === next) return;
  previous.replaced = true;
  sendJson(previous, { type: 'error', message });
  try {
    previous.close();
  } catch {}
  setTimeout(() => {
    if (previous.readyState !== WebSocket.CLOSED) previous.terminate();
  }, 1_000).unref();
}

function retirePublisherTransport(
  previous: RelaySocket | null,
  type: 'mic-revoked' | 'publisher-superseded',
  message: string,
) {
  if (!previous) return false;
  previous.replaced = true;
  sendJson(previous, { type, message });
  try {
    previous.close();
  } catch {}
  setTimeout(() => {
    if (previous.readyState !== WebSocket.CLOSED) previous.terminate();
  }, 1_000).unref();
  return true;
}

function publisherStatusPayload() {
  return {
    type: 'publisher-status',
    connected: micMediaConnected(),
    sampleRate: micRuntime.sampleRate,
    mediaPath: micMediaPath(),
  };
}

function calibrationIsStale() {
  return calibration.isStaleFor(calibrationContext());
}

function calibrationCanApply() {
  const result = calibration.result;
  if (result === null || calibrationIsStale()) return false;
  if (
    robotProbeTimingActive()
    && timingRuntime.calibrationKind !== 'boot-probe'
    && !probeCalibrationExhausted()
  ) return false;
  // Boot calibration is a three-term equation. The two probe legs may be
  // measured ahead of playback, but an unknown player delta is not zero. Keep
  // the path result as evidence and stay on the network fallback until the
  // active robot has published a fresh, settled delta.
  if (robotProbeTimingActive() && timingRuntime.calibrationKind === 'boot-probe' && !robotDeltaIsFresh()) return false;
  // A Robot content result is expressed in the mapper's stable reference frame.
  // It can own the live mixer only while the current media mapping is known.
  if (
    robotProbeTimingActive()
    && timingRuntime.calibrationKind === 'content'
    && !robotContentMappingReady()
  ) return false;
  return true;
}

/**
 * Synchronizes measurement validity into the mixer's active alignment.
 *
 * A boot result needs special treatment: once freshness/connection withdraws
 * its authority, a later delta must not resurrect the historical total before
 * `maybeReapplyBootCalibration()` has folded in the *current* delta. While a
 * boot alignment is already active, small (< threshold) delta movements are
 * intentionally left alone. While it is inactive, it may only be restored
 * directly when the stored boot result already describes exactly the current
 * reported delta; otherwise reapply owns the reactivation.
 *
 * Returns whether the mixer alignment changed so the periodic freshness check
 * can publish the transition immediately.
 */
function syncAppliedCalibration() {
  if (takeBlocksCalibration()) return false;
  const active = session.alignment.calibratedMicLagMs;

  if (robotProbeTimingActive() && timingRuntime.calibrationKind === 'boot-probe') {
    if (!calibrationCanApply()) {
      if (active === null) return false;
      session.setAlignment({ calibratedMicLagMs: null });
      return true;
    }

    const result = calibration.result;
    if (active !== null) {
      if (result !== null && active !== result.micLagMs) {
        session.setAlignment({ calibratedMicLagMs: result.micLagMs });
        return true;
      }
      return false;
    }

    const storedDeltaMs = bootProbeRuntime.calibrationResult?.deltaMs;
    const currentDelta = currentDeltaMs(performance.now());
    if (
      result !== null
      && storedDeltaMs !== undefined
      && Math.abs(storedDeltaMs - currentDelta) < 0.001
    ) {
      session.setAlignment({ calibratedMicLagMs: result.micLagMs });
      return true;
    }
    return false;
  }

  let nextMicLagMs = calibrationCanApply() ? calibration.result!.micLagMs : null;
  const robotContentAuthority = robotProbeTimingActive() && timingRuntime.calibrationKind === 'content';
  if (nextMicLagMs !== null && robotContentAuthority) {
    nextMicLagMs = robotContentTimeline.liveLagMs(
      nextMicLagMs,
      calibrationContext(),
      performance.now(),
    );
  }

  // The Robot offset tracker is deliberately smoothed, but its residual noise is
  // still not a reason to splice the Mic read head every 250 ms. The same bounded
  // threshold used by boot re-application keeps content mapping corrections real
  // while ignoring sub-threshold player jitter.
  if (
    robotContentAuthority
    && timingRuntime.contentValidationSlewRevision === null
    && active !== null
    && nextMicLagMs !== null
    && Math.abs(nextMicLagMs - active) < BOOT_DELTA_REAPPLY_MS
  ) return false;

  if (active === nextMicLagMs) {
    if (timingRuntime.contentValidationSlewMatches(calibration.confirmedRevision)) {
      timingRuntime.clearContentValidationSlew();
    }
    return false;
  }

  if (
    timingRuntime.calibrationKind === 'content'
    && active !== null
    && nextMicLagMs !== null
    && timingRuntime.contentValidationSlewMatches(calibration.confirmedRevision)
  ) {
    timingRuntime.clearContentValidationSlew();
    return session.slewCalibratedMicLagTo(nextMicLagMs);
  }

  // The periodic synchronizer runs while a live validation slew is still in
  // progress. Seeing a different applied value is expected; do not snap it to
  // the already-known target on the next 250 ms tick.
  if (nextMicLagMs !== null && session.calibratedMicLagTarget === nextMicLagMs) return false;

  timingRuntime.clearContentValidationSlew();
  session.setAlignment({ calibratedMicLagMs: nextMicLagMs });
  return true;
}

function sourceStatusPayload() {
  const alignment = session.alignment;
  const calibrationStatus = calibration.status();
  const nowMs = performance.now();
  return {
    type: 'source-status',
    connected: backingRuntime.connected(),
    micConnected: micMediaConnected(),
    micMediaPath: micMediaPath(),
    backingStreaming: backingRuntime.streaming(nowMs, STREAM_LIVE_MS),
    micStreaming: micStreaming(nowMs),
    sampleRate: backingRuntime.sampleRate,
    active: session.active,
    prebufferMs: session.prebufferMs,
    mixSampleRate: MIX_SAMPLE_RATE,
    micNetworkCompensationMs: alignment.networkCompensationMs,
    calibratedMicLagMs: calibrationStatus.micLagMs,
    activeCalibratedMicLagMs: alignment.calibratedMicLagMs,
    timingMode: alignment.calibratedMicLagMs === null ? 'network-estimate' : 'acoustic-calibration',
    calibrationStale: calibrationIsStale(),
    calibrationKind: timingRuntime.calibrationKind,
    robotRoute: robotProbeTimingActive(),
    robotSourceConnected: sourceRuntime.connected(),
    robotDeltaFresh: robotDeltaIsFresh(nowMs),
    vocalFineTuneMs: alignment.fineTuneMs,
    appliedMicAdvanceMs: session.appliedMicAdvanceMs,
    requestedMicAdvanceMs: session.requestedMicAdvanceMs,
  };
}

function takeQualityFrameState(nowMs = performance.now()) {
  const alignment = session.alignment;
  return {
    timingMode: alignment.calibratedMicLagMs === null
      ? 'network-estimate' as const
      : 'acoustic-calibration' as const,
    calibrationStale: calibrationIsStale(),
    alignmentClamped: Math.abs(session.requestedMicAdvanceMs - session.appliedMicAdvanceMs) >= 0.5,
    robotRoute: robotProbeTimingActive(),
    robotDeltaFresh: robotDeltaIsFresh(nowMs),
  };
}

function micUplinkHealthPayload(nowMs = performance.now()) {
  return micRuntime.uplinkHealthPayload(nowMs);
}

function mixHealthPayload() {
  const health = session.health();
  return {
    type: 'mix-health',
    active: session.active,
    ...health,
    recommendedMicGainDb: recommendedMicGainDb(health.micPeakDbfs),
    micGainDb: session.micGainDb,
    monitorDroppedFrames: monitorTransport.droppedFrames,
    prebufferMs: session.prebufferMs,
    micMediaPath: micMediaPath(),
    micUplink: micUplinkHealthPayload(),
    micTransport: micRuntime.receiverStats(),
  };
}

function frameAgeMs(atMs: number, nowMs: number) {
  return Number.isFinite(atMs) ? Math.round(nowMs - atMs) : null;
}

/**
 * The status another machine can poll.
 *
 * `/healthz` answers "is the Relay process up", which stays `true` through
 * every failure an unattended robot actually has: the browser died, the sink
 * vanished, the backing bridge stopped. This reports on the *route* instead.
 *
 * It reduces that to `ok` plus named faults so the poller does not have to
 * model Relay's internals. A fault is something that is definitely broken - a
 * connected client that stopped sending audio, or a robot route missing a
 * component - never merely "nobody is singing", which is what `idle` is for.
 * Warnings degrade quality without stopping audio, so they do not clear `ok`.
 *
 * Deliberately carries no nicknames or keys: it is unauthenticated on the LAN
 * like `/healthz`, so it reports counts and states only.
 */
function remoteStatusPayload() {
  const nowMs = performance.now();
  const alignment = session.alignment;
  const snapshot = participants.snapshot();
  const mixHealth = session.health();

  const readiness = readinessPayload(nowMs);
  const health = deriveRemoteStatusHealth(readiness);
  const components = readiness.components;
  const backingConnected = components.backing.connected;
  const micConnected = components.mic.connected;
  const backingStreaming = components.backing.streaming;
  const micStreaming = components.mic.streaming;
  const routeMode = components.route.mode;
  const robotRoute = routeMode === 'robot';
  const robotSourceConnected = components.robotSource.connected;
  const deltaFresh = components.player.offsetFresh;

  return {
    ok: health.ok,
    state: health.state,
    faults: health.faults,
    warnings: health.warnings,
    uptimeMs: Math.round(nowMs),
    source: {
      backingConnected,
      backingStreaming,
      backingSampleRate: components.backing.sampleRate,
      backingIsRobot: components.backing.robot,
      backingFrameAgeMs: frameAgeMs(backingRuntime.lastFrameAt, nowMs),
      micConnected,
      micStreaming,
      micMediaPath: micMediaPath(),
      micFrameAgeMs: micRuntime.frameAgeMs(nowMs),
      participants: snapshot.participants.length,
      participantsConnected: snapshot.participants.filter((participant) => participant.connected).length,
    },
    robot: {
      route: robotRoute,
      sourceConnected: robotSourceConnected,
      deltaFresh,
      calibrationKind: components.calibration.kind,
      calibrationStale: components.calibration.stale,
      timingMode: alignment.calibratedMicLagMs === null ? 'network-estimate' : 'acoustic-calibration',
      activeCalibratedMicLagMs: alignment.calibratedMicLagMs,
    },
    mix: {
      active: session.active,
      ...mixHealth,
      monitorDroppedFrames: monitorTransport.droppedFrames,
    },
    audio: {
      micMediaPath: micMediaPath(),
      captureAndSender: micUplinkHealthPayload(nowMs),
      receiverTransport: micRuntime.receiverStats(),
      timeline: {
        micGapMs: mixHealth.micGapMs,
        micHeadroomMs: mixHealth.micHeadroomMs,
        micStarvedFrames: mixHealth.micStarvedFrames,
      },
    },
  };
}

function observationStatusV1Payload() {
  const remote = remoteStatusPayload();
  const snapshot = participants.snapshot();

  return buildRelayObservationStatusV1({
    workload: {
      id: 'relay',
      state: remote.state,
      ok: remote.ok,
      uptimeMs: remote.uptimeMs,
    },
    activity: {
      sessionActive: remote.mix.active,
      participants: {
        total: remote.source.participants,
        connected: remote.source.participantsConnected,
      },
      microphoneLease: {
        held: snapshot.micOwnerId !== null,
        transportConnected: remote.source.micConnected,
      },
    },
    sources: {
      backing: {
        connected: remote.source.backingConnected,
        streaming: remote.source.backingStreaming,
        sampleRate: remote.source.backingSampleRate,
        robot: remote.source.backingIsRobot,
        frameAgeMs: remote.source.backingFrameAgeMs,
      },
      microphone: {
        connected: remote.source.micConnected,
        streaming: remote.source.micStreaming,
        sampleRate: micRuntime.sampleRate,
        frameAgeMs: remote.source.micFrameAgeMs,
      },
      robot: {
        routeActive: remote.robot.route,
        sourceConnected: remote.robot.sourceConnected,
        playerDeltaFresh: remote.robot.deltaFresh,
      },
    },
    calibration: {
      kind: remote.robot.calibrationKind === 'boot-probe'
        ? 'boot-probe'
        : remote.robot.calibrationKind === 'content'
          ? 'content'
          : 'none',
      stale: remote.robot.calibrationStale,
      timingMode: remote.robot.timingMode,
      activeCalibratedMicLagMs: remote.robot.activeCalibratedMicLagMs,
    },
    mix: remote.mix,
    issues: {
      faults: remote.faults,
      warnings: remote.warnings,
    },
  });
}

function recommendedMicGainDb(micPeakDbfs: number | null) {
  if (micPeakDbfs === null || !Number.isFinite(micPeakDbfs)) return null;
  return Math.max(0, Math.min(MAX_RECOMMENDED_MIC_GAIN_DB, Math.round(LIMITER_THRESHOLD_DBFS - micPeakDbfs)));
}

function probeStatus(nowMs = performance.now()) {
  return bootProbeRuntime.status(nowMs);
}

function bootProbeInProgress(nowMs = performance.now()) {
  return timingRuntime.calibrationKind === 'boot-probe'
    && (calibration.result === null || calibration.transactionActive)
    && probeStatus(nowMs).active;
}

function timingCalibrationInProgress(nowMs = performance.now()) {
  return calibration.collecting || bootProbeInProgress(nowMs);
}

function takeBlocksCalibration() {
  return takeController.lifecycle === 'recording' || takeController.lifecycle === 'finalizing';
}

function timingCalibrationStatusPayload() {
  const alignment = session.alignment;
  const status = calibration.status();
  const nowMs = performance.now();
  const probe = probeStatus(nowMs);
  return {
    type: 'timing-calibration-status',
    ...status,
    activeMicLagMs: alignment.calibratedMicLagMs,
    timingMode: alignment.calibratedMicLagMs === null ? 'network-estimate' : 'acoustic-calibration',
    calibrationStale: calibrationIsStale(),
    calibrationKind: timingRuntime.calibrationKind,
    robotRoute: robotProbeTimingActive(),
    robotSourceConnected: sourceRuntime.connected(),
    robotDeltaFresh: robotDeltaIsFresh(nowMs),
    robotContentTransition: robotContentTransitionStatus(nowMs),
    fallbackNetworkMs: alignment.networkCompensationMs,
    vocalFineTuneMs: alignment.fineTuneMs,
    appliedMicAdvanceMs: session.appliedMicAdvanceMs,
    requestedMicAdvanceMs: session.requestedMicAdvanceMs,
    probeCorrelation: bootProbeRuntime.correlations,
    probeActive: bootProbeInProgress(nowMs),
    probePhase: probe.phase,
    probeAttempts: probe.attempts,
    probeMaxAttempts: probe.maxAttempts,
    probeError: probe.error,
    bootCalibration: bootProbeRuntime.calibrationResult,
    robotPlayerOffsetMs: robotDeltaIsFresh(nowMs) ? robotPlayerOffset.offsetMs(nowMs) : null,
    automatic: timingRuntime.automatic,
    autoCalibrate: AUTO_CALIBRATE,
    validation: contentCalibrationValidator.status(nowMs),
  };
}

function mixSettingsPayload() {
  return {
    type: 'mix-settings',
    micGainDb: session.micGainDb,
    songLevel,
  };
}

function currentTimelineStatus(nowMs = performance.now()) {
  return youtubeTimeline.statusPayload(nowMs) as TimelineStatus & Record<string, unknown>;
}

/**
 * One runtime readiness collector shared by diagnostics and product UI.
 *
 * Keep transport facts here rather than reconstructing them in /readyz, the
 * browser, or ProductViewModel independently. The pure readiness model decides
 * what those facts mean; this function only samples the live server once.
 */
function readinessRouteMode(nowMs = performance.now()) {
  if (backingRuntime.isRobot || sourceRuntime.connected()) return 'robot' as const;
  if (backingRuntime.armed()) return 'legacy' as const;
  // Voice-only is valid only while the room truly has no Song. Once a Song
  // exists, backing is an expected dependency even before a concrete route
  // has announced itself.
  if (roomHasSong(nowMs)) return 'song' as const;
  return 'idle' as const;
}

function readinessPayload(nowMs = performance.now()) {
  const timeline = currentTimelineStatus(nowMs);
  const calibrationStatus = calibration.status();
  const timelineState = Number(timeline.state);

  return buildReadiness({
    routeMode: readinessRouteMode(nowMs),
    backingConnected: backingRuntime.connected(),
    backingStreaming: backingRuntime.streaming(nowMs, STREAM_LIVE_MS),
    backingSampleRate: backingRuntime.sampleRate,
    backingIsRobot: backingRuntime.isRobot,
    micConnected: micMediaConnected(),
    micStreaming: micStreaming(nowMs),
    micFlowObserved: micFlowObserved(),
    micStartupTimedOut: micStartupTimedOut(nowMs),
    robotSourceConnected: sourceRuntime.connected(),
    sessionActive: session.active,
    timelineConnected: Boolean(timeline.connected && timeline.videoId),
    timelineState: Number.isFinite(timelineState) ? timelineState : null,
    playerOffsetMs: robotPlayerOffset.offsetMs(nowMs),
    playerOffsetFresh: robotDeltaIsFresh(nowMs),
    calibrationState: String(calibrationStatus.state ?? 'idle'),
    calibrationValid: calibrationCanApply() && session.alignment.calibratedMicLagMs !== null,
    calibrationStale: calibrationIsStale(),
    calibrationKind: timingRuntime.calibrationKind,
    probeCorrelation: bootProbeRuntime.correlations,
    bootCalibration: bootProbeRuntime.calibrationResult,
  });
}

function productStatusPayload(nowMs = performance.now()) {
  const readiness = readinessPayload(nowMs);
  const participantSnapshot = participants.snapshot();
  const micOwner = participantSnapshot.micOwnerId
    ? participantSnapshot.participants.find((participant) => participant.id === participantSnapshot.micOwnerId) ?? null
    : null;
  const room = youtubeTimeline.roomStatusPayload(nowMs) as Record<string, unknown>;
  const roomState = Number(room.state);
  // `connected` answers "is the clock authoritative right now", on a window
  // tight enough for alignment. Telling a singer their playback is unavailable
  // is a different question with a different answer, so the product view gets
  // the raw age and draws its own, slower line.
  const timelineAgeMs = Number(
    (youtubeTimeline.statusPayload(nowMs) as Record<string, unknown>).ageMs,
  );
  const takeStatus = takeController.statusPayload();
  const take = takeStatus.take;
  const alignment = session.alignment;
  const calibrationStatus = calibration.status();

  return buildProductViewModel({
    readiness,
    participantCount: participantSnapshot.participants.length,
    micOwnerId: participantSnapshot.micOwnerId,
    micOwnerNickname: micOwner?.nickname ?? null,
    publisherControlConnected: micRuntime.controlConnected(),
    roomSong: {
      videoId: typeof room.videoId === 'string' && room.videoId ? room.videoId : null,
      connected: Boolean(room.connected),
      clockAgeMs: Number.isFinite(timelineAgeMs) ? timelineAgeMs : Number.POSITIVE_INFINITY,
      state: Number.isFinite(roomState) ? roomState : null,
      handoffState: typeof room.handoffState === 'string' ? room.handoffState : 'idle',
    },
    take: {
      lifecycle: takeStatus.lifecycle,
      takeId: take?.takeId ?? null,
      qualityVerdict: take?.quality?.verdict ?? null,
    },
    timing: {
      timingMode: alignment.calibratedMicLagMs === null ? 'network-estimate' : 'acoustic-calibration',
      calibrationState: String(calibrationStatus.state ?? 'idle'),
      calibrationActive: timingCalibrationInProgress(nowMs),
      calibrationStale: calibrationIsStale(),
      alignmentClamped: Math.abs(session.requestedMicAdvanceMs - session.appliedMicAdvanceMs) >= 0.5,
      requiresRobotPlayerDelta: robotProbeTimingActive() && timingRuntime.calibrationKind === 'boot-probe',
      robotProbeTimingActive: robotProbeTimingActive(),
      robotDeltaFresh: robotDeltaIsFresh(nowMs),
    },
  });
}

let lastProductStatusJson = '';
function broadcastProductStatus(nowMs = performance.now()) {
  const status = productStatusPayload(nowMs);
  const serialized = JSON.stringify(status);
  if (serialized === lastProductStatusJson) return false;
  lastProductStatusJson = serialized;
  broadcastJson(status);
  return true;
}

function broadcastStatus() {
  monitorTransport.broadcast(JSON.stringify(publisherStatusPayload()));
  broadcastJson(sourceStatusPayload());
}

function revokePublisherTransport(message: string) {
  const previous = micRuntime.publisher;
  const hadMedia = Boolean(previous || micRuntime.audioTransport || micRuntime.mediaTicket);
  if (previous) micRuntime.detachPublisher(previous);
  clearMicMediaAuthority();
  if (previous) retirePublisherTransport(previous, 'mic-revoked', message);
  broadcastStatus();
  return hadMedia;
}

const micTimingInvalidationCoordinator = createRelayMicTimingInvalidationCoordinator({
  clearBootCalibration: () => clearBootCalibrationState(),
  clearContentValidation: () => clearContentValidationBaseline(),
  invalidateCalibration: (message) => {
    if (calibration.collecting) calibration.fail(message);
    else calibration.reset();
  },
  clearTimingKind: () => timingRuntime.clearCalibrationKind(),
  resetAutoCalibrationSchedule: () => timingRuntime.resetAutoCalibrationSchedule(),
  syncAppliedCalibration: () => { syncAppliedCalibration(); },
  reportTimingStatus: () => broadcastJson(timingCalibrationStatusPayload()),
  reportSourceStatus: () => broadcastJson(sourceStatusPayload()),
});

function invalidateMicTiming(message: string) {
  micTimingInvalidationCoordinator.invalidate(message);
}

function refreshLiveMicNetworkCompensation() {
  const timeline = currentTimelineStatus();
  const transportEstimateMs = Number(timeline.transportEstimateMs);
  session.setAlignment({
    networkCompensationMs: Number.isFinite(transportEstimateMs)
      ? Math.max(0, Math.min(MAX_OFFSET_MS, transportEstimateMs))
      : 0,
  });
}

function startLiveSource() {
  backingRuntime.cancelGrace();

  if (session.active) {
    refreshLiveMicNetworkCompensation();
    broadcastJson(sourceStatusPayload());
    broadcastJson(timingCalibrationStatusPayload());
    return;
  }

  session.start();
  refreshLiveMicNetworkCompensation();
  broadcastJson(sourceStatusPayload());
  broadcastJson(mixSettingsPayload());
  broadcastJson(timingCalibrationStatusPayload());
}

function restartLiveSourceAfterMicReconnect() {
  if (!session.active || !backingRuntime.connected()) return;
  refreshLiveMicNetworkCompensation();
  if (calibration.collecting) {
    calibration.fail('Microphone reconnected during calibration. Start calibration again.');
  }
  if (cancelActiveContentValidation()) broadcastJson(timingCalibrationStatusPayload());
  broadcastJson(sourceStatusPayload());
}

function abandonProbeRun() {
  bootProbeRuntime.abandonRun();
}

function clearBootCalibrationState() {
  bootProbeRuntime.clear();
}

const liveSourceStopCoordinator = createRelayLiveSourceStopCoordinator({
  cancelBackingGrace: () => backingRuntime.cancelGrace(),
  retireRobotRoute: () => backingRuntime.retireRobotRoute(),
  sessionActive: () => session.active,
  endTakeMix: () => takeController.endMix(),
  clearBootCalibration: () => clearBootCalibrationState(),
  clearContentValidation: () => clearContentValidationBaseline(),
  resetRobotPlayerOffset: () => robotPlayerOffset.reset(),
  resetRobotContentTimeline: () => robotContentTimeline.reset(),
  clearRobotBackingBoundaryRequest: () => clearRobotBackingBoundaryRequest(),
  stopSession: () => session.stop(),
  resetCalibration: () => calibration.reset(),
  clearTimingKind: () => timingRuntime.clearCalibrationKind(),
  resetAutoCalibrationSchedule: () => timingRuntime.resetAutoCalibrationSchedule(),
  reportTimingStatus: () => broadcastJson(timingCalibrationStatusPayload()),
  reportSourceStatus: () => broadcastJson(sourceStatusPayload()),
  reportStatus: () => broadcastStatus(),
});

function stopLiveSource() {
  liveSourceStopCoordinator.stop();
}

function roomHasSong(nowMs = performance.now()) {
  return takeSongSnapshot(nowMs).videoId !== null;
}

function maybeStopLiveSourceWhenUnarmed() {
  if (!session.active) return;
  const micArmed = micRuntime.controlConnected()
    || webTransportMicConnected()
    || micTransportGrace.pending;
  const backingArmed = backingRuntime.armed();
  if (!micArmed && !backingArmed) stopLiveSource();
}

function expireBackingGrace() {
  const micArmed = micRuntime.controlConnected()
    || webTransportMicConnected()
    || micTransportGrace.pending;
  if (roomHasSong() || !micArmed) {
    stopLiveSource();
    return;
  }

  backingRuntime.retireRobotRoute();
  clearRobotBackingBoundaryRequest();
  invalidateMicTiming('Backing route ended while the room continued voice-only.');
  broadcastStatus();
}


const micCaptureRestartCoordinator = createRelayMicCaptureRestartCoordinator({
  noteQualityEvent: (event) => takeController.noteQualityEvent(event),
  abandonProbeRun: () => abandonProbeRun(),
  clearContentValidation: () => clearContentValidationBaseline(),
  failCalibration: (message) => calibration.fail(message),
  syncAppliedCalibration: () => { syncAppliedCalibration(); },
  reportTimingStatus: () => broadcastJson(timingCalibrationStatusPayload()),
  reportSourceStatus: () => broadcastJson(sourceStatusPayload()),
});

function processPublisherFrame(frame: PcmFrame) {
  // Physical media can outlive the control WebSocket during its reconnect
  // grace. Authorization already happened at the WS publisher boundary or the
  // short-lived WebTransport media ticket boundary, so the mixer must not make
  // a control socket pointer into a second source of truth.
  if (!micRuntime.audioTransport || micRuntime.sampleRate === null) return;
  if (!session.active) startLiveSource();

  if (session.active) {
    const previousGeneration = session.micGeneration;
    noteMicFrame(performance.now());
    const { samples, start } = session.ingestMic(frame, micRuntime.sampleRate);

    if (session.active) {
      const micRestarted = previousGeneration !== null && session.micGeneration !== previousGeneration;
      if (micRestarted) {
        micCaptureRestartCoordinator.restart({
          calibrationCollecting: calibration.collecting,
        });
      }
      if (robotContentFallbackPrimingActive()) {
        calibration.primeMic(samples, start);
      }
      calibration.observeMic(samples, start);
      contentCalibrationValidator.observeMic(samples, start);
      robotContentTransitionRuntime.noteMicProgress();
    }
  } else {
    monitorTransport.broadcast(frame.pcm, true);
  }
}

function deliverMicPackets(packets: PcmFrame[]) {
  for (const packet of packets) processPublisherFrame(packet);
}

const mixerTimer = setInterval(() => {
  if (micRuntime.audioTransport) {
    deliverMicPackets(micRuntime.flush(performance.now()));
  }

  session.drain((frame, evidence, position) => {
    const nowMs = performance.now();
    takeController.append(frame, takeQualityFrameState(nowMs), evidence, position);
    monitorTransport.broadcast(frame, true, position);
  });
}, 5);

function maybeAutoCalibrate(nowMs: number) {
  if (!AUTO_CALIBRATE || takeBlocksCalibration()) return;
  const exhaustedRobotProbe = probeCalibrationExhausted(nowMs);
  if (robotProbeTimingActive() && !exhaustedRobotProbe) return;
  if (robotProbeTimingActive() && !robotContentMappingReady(nowMs)) return;
  if (!session.active || calibration.collecting) return;
  if (calibration.confirmedResult !== null && !calibrationIsStale()) return;
  if (!timingRuntime.autoCalibrationDue(nowMs)) return;

  if (!backingRuntime.connected() || !micRuntime.controlConnected()) return;
  if (!bothStreamsFlowing(nowMs)) return;
  const timeline = currentTimelineStatus();
  if (!timeline.connected || Number(timeline.state) !== 1) return;

  timingRuntime.beginContentCalibration(nowMs, true);
  if (exhaustedRobotProbe) calibration.startFromPrimed(nowMs);
  else calibration.start(nowMs);
  broadcastJson(timingCalibrationStatusPayload());
}

function contentValidationPathReady(nowMs: number) {
  if (!CONTENT_VALIDATION_ENABLED || takeBlocksCalibration()) return false;
  if (robotProbeTimingActive() && !probeCalibrationExhausted(nowMs)) return false;
  if (robotProbeTimingActive() && !robotContentMappingReady(nowMs)) return false;
  if (!session.active || calibration.collecting) return false;
  if (
    timingRuntime.calibrationKind !== 'content'
    || calibration.confirmedResult === null
    || calibrationIsStale()
  ) return false;
  if (!backingRuntime.connected() || !micRuntime.controlConnected()) return false;
  if (!bothStreamsFlowing(nowMs)) return false;
  const timeline = currentTimelineStatus(nowMs);
  return Boolean(timeline.connected) && Number(timeline.state) === 1;
}

function maybeValidateContentCalibration(nowMs: number) {
  syncContentValidationBaseline(nowMs);
  if (!contentCalibrationValidator.hasBaseline) return;

  const state = contentCalibrationValidator.status(nowMs).state;
  if (!contentValidationPathReady(nowMs)) {
    if (contentCalibrationValidator.collecting || state === 'suspect') {
      contentCalibrationValidator.cancel(nowMs);
    }
    return;
  }

  // Every state transition publishes through validator.onChange. Return values
  // remain useful to domain tests but are no longer a second telemetry channel.
  contentCalibrationValidator.tick(nowMs);
  contentCalibrationValidator.maybeStart(nowMs);
}

function probeGeneration(target: ProbeTarget) {
  return target === 'mic' ? session.micGeneration : session.backingGeneration;
}

function bootProbeContext() {
  return {
    sessionGeneration: session.generation,
    micGeneration: session.micGeneration,
    backingGeneration: session.backingGeneration,
  };
}

function probePathReady(target: ProbeTarget, nowMs: number) {
  if (target === 'mic') {
    return micRuntime.controlConnected() && micStreaming(nowMs);
  }
  return backingRuntime.connected()
    && backingRuntime.streaming(nowMs, STREAM_LIVE_MS)
    && sourceRuntime.connected();
}

function failProbeAttempt(target: ProbeTarget, reason: string, nowMs: number) {
  const failure = bootProbeRuntime.failAttempt(target, reason, nowMs);
  if (failure) {
    timingRuntime.markBootProbeAuthority();
    calibration.failPreservingPrimed(failure.message);
    return;
  }
  broadcastJson(timingCalibrationStatusPayload());
}

function sendProbeRequest(target: ProbeTarget, nowMs: number) {
  if (timingRuntime.calibrationKind !== 'boot-probe') {
    timingRuntime.beginBootProbe(true);
  }

  const requestId = bootProbeRuntime.nextRequestId();
  const request = {
    target,
    requestId,
    serverSentAtMs: nowMs,
    sessionGeneration: session.generation,
    generation: probeGeneration(target),
  };
  if (!bootProbeRuntime.beginRequest(request)) return;

  if (PROBE_DEBUG) console.log(`[probe] ${target} sent #${requestId} generation=${request.generation}`);

  const payload = { type: 'play-calibration-probe', target, requestId, leadMs: PROBE_LEAD_MS };
  if (target === 'mic') {
    sendJson(micRuntime.publisher!, payload);
  } else if (sourceRuntime.socket) {
    sendJson(sourceRuntime.socket, payload);
  }
  broadcastJson(timingCalibrationStatusPayload());
}

function maybeStartProbeCalibration(nowMs: number) {
  if (!PROBE_CALIBRATE || !robotProbeTimingActive() || takeBlocksCalibration()) return;
  if (!session.active || calibration.collecting) return;

  const context = bootProbeContext();
  if (bootProbeRuntime.micLeg !== null && !bootProbeRuntime.micLegMatches(context)) {
    abandonProbeRun();
  }

  if (
    timingRuntime.calibrationKind === 'boot-probe'
    && calibration.result !== null
    && !calibrationIsStale()
    && !calibration.transactionActive
  ) return;
  if (bootProbeRuntime.pendingRequest !== null || bootProbeRuntime.pendingAnalysis !== null) return;
  if (probeStatus(nowMs).error !== null) return;

  if (
    !calibration.transactionActive
    && bootProbeRuntime.micLeg === null
    && bootProbeRuntime.completedContextMatches(context)
  ) return;

  const target: ProbeTarget = bootProbeRuntime.micLeg === null ? 'mic' : 'backing';
  if (!bootProbeRuntime.canStart(target, nowMs)) return;
  if (!probePathReady(target, nowMs)) return;
  sendProbeRequest(target, nowMs);
}

function handleProbeReply(reply: { requestId: unknown; generation: unknown }, nowMs: number) {
  const pending = bootProbeRuntime.acceptClientReply(reply.requestId, reply.generation);
  if (!pending) return;
  if (!session.active || pending.sessionGeneration !== session.generation) {
    abandonProbeRun();
    broadcastJson(timingCalibrationStatusPayload());
    return;
  }

  const generationHeld = probeGeneration(pending.target) === pending.generation;
  if (!generationHeld) {
    if (PROBE_DEBUG) console.log(`[probe] ${pending.target} dropped: capture generation changed`);
    abandonProbeRun();
    broadcastJson(timingCalibrationStatusPayload());
    return;
  }

  const clientAgrees = pending.target === 'mic'
    ? (Number(reply.generation) >>> 0) === pending.generation
    : true;
  if (!clientAgrees) {
    if (PROBE_DEBUG) console.log(`[probe] ${pending.target} dropped: client generation mismatch`);
    failProbeAttempt(pending.target, 'client reported a different capture generation', nowMs);
    return;
  }

  const oneWayMs = (nowMs - pending.serverSentAtMs) / 2;
  const targetSample = Math.round(session.sessionSampleAt(pending.serverSentAtMs + oneWayMs + PROBE_LEAD_MS));
  const marginSamples = Math.round((MIX_SAMPLE_RATE * PROBE_SEARCH_MARGIN_MS) / 1000);
  const referenceSamples = Math.round((MIX_SAMPLE_RATE * PROBE_REFERENCE_MS) / 1000);

  bootProbeRuntime.beginAnalysis({
    target: pending.target,
    targetSample,
    windowStart: targetSample - Math.round(marginSamples / 8),
    windowSamples: referenceSamples + marginSamples,
    sessionGeneration: pending.sessionGeneration,
    generation: pending.generation,
    deadlineMs: nowMs + PROBE_ANALYSIS_TIMEOUT_MS,
  });
  broadcastJson(timingCalibrationStatusPayload());
}

function handleProbeFailure(
  reply: { requestId: unknown; generation: unknown; reason: unknown },
  nowMs: number,
) {
  const pending = bootProbeRuntime.acceptClientReply(reply.requestId, reply.generation);
  if (!pending) return;
  if (!session.active || pending.sessionGeneration !== session.generation) {
    abandonProbeRun();
    broadcastJson(timingCalibrationStatusPayload());
    return;
  }

  if (probeGeneration(pending.target) !== pending.generation) {
    abandonProbeRun();
    broadcastJson(timingCalibrationStatusPayload());
    return;
  }

  if (
    pending.target === 'mic'
    && (Number(reply.generation) >>> 0) !== pending.generation
  ) {
    failProbeAttempt('mic', 'client failed from a different capture generation', nowMs);
    return;
  }

  const rawReason = typeof reply.reason === 'string' ? reply.reason.trim() : '';
  const reason = rawReason ? rawReason.slice(0, 240) : 'client could not play the probe';
  failProbeAttempt(pending.target, reason, nowMs);
}

function maybeFinishProbeAnalysis(nowMs: number) {
  const waiting = bootProbeRuntime.pendingAnalysis;
  if (!waiting) return;

  const reached = waiting.target === 'mic' ? session.micTotalSamples : session.backingTotalSamples;
  const needed = waiting.windowStart + waiting.windowSamples;

  if (!session.active || waiting.sessionGeneration !== session.generation) {
    abandonProbeRun();
    broadcastJson(timingCalibrationStatusPayload());
    return;
  }

  if (probeGeneration(waiting.target) !== waiting.generation) {
    if (PROBE_DEBUG) console.log(`[probe] ${waiting.target} analysis dropped: capture generation changed`);
    abandonProbeRun();
    broadcastJson(timingCalibrationStatusPayload());
    return;
  }

  if (nowMs > waiting.deadlineMs) {
    if (PROBE_DEBUG) {
      console.log(
        `[probe] ${waiting.target} analysis timed out: reached=${reached} needed=${needed}`,
      );
    }
    bootProbeRuntime.takeAnalysis();
    failProbeAttempt(waiting.target, 'captured audio did not reach the analyzer before timeout', nowMs);
    return;
  }

  if (reached < needed) return;
  const analysis = bootProbeRuntime.takeAnalysis();
  if (!analysis) return;

  const window = analysis.target === 'mic'
    ? session.readMic(analysis.windowStart, analysis.windowSamples)
    : session.readBacking(analysis.windowStart, analysis.windowSamples);
  const { offsetSamples, correlation } = locateProbe(window, MIX_SAMPLE_RATE);
  const actualSample = analysis.windowStart + offsetSamples;
  const latencyMs = ((actualSample - analysis.targetSample) / MIX_SAMPLE_RATE) * 1000;
  bootProbeRuntime.noteCorrelation(analysis.target, correlation);

  if (PROBE_DEBUG) {
    let peak = 0;
    for (let i = 0; i < window.length; i += 1) {
      const magnitude = Math.abs(window[i]);
      if (magnitude > peak) peak = magnitude;
    }
    const controlSeconds = 20;
    const recent = analysis.target === 'mic'
      ? session.readMic(reached - MIX_SAMPLE_RATE * controlSeconds, MIX_SAMPLE_RATE * controlSeconds)
      : session.readBacking(reached - MIX_SAMPLE_RATE * controlSeconds, MIX_SAMPLE_RATE * controlSeconds);
    let recentPeak = 0;
    for (let i = 0; i < recent.length; i += 1) {
      const magnitude = Math.abs(recent[i]);
      if (magnitude > recentPeak) recentPeak = magnitude;
    }
    console.log(
      `[probe] ${analysis.target} correlation=${correlation.toFixed(3)} latencyMs=${latencyMs.toFixed(0)}`
      + ` windowPeak=${peak} recent${controlSeconds}sPeak=${recentPeak}`
      + ` windowStart=${analysis.windowStart} needed=${needed} reached=${reached}`,
    );
  }

  if (correlation < PROBE_MIN_CORRELATION) {
    failProbeAttempt(
      analysis.target,
      `correlation ${correlation.toFixed(3)} was below ${PROBE_MIN_CORRELATION.toFixed(3)}`,
      nowMs,
    );
    return;
  }

  const leg = { targetSample: analysis.targetSample, actualSample, correlation };

  if (analysis.target === 'mic') {
    bootProbeRuntime.setMicLeg({
      ...leg,
      sessionGeneration: session.generation,
      micGeneration: analysis.generation,
    });
    broadcastJson(timingCalibrationStatusPayload());
    return;
  }

  const micLeg = bootProbeRuntime.takeMicLeg();
  if (
    micLeg === null
    || micLeg.sessionGeneration !== session.generation
    || micLeg.micGeneration !== session.micGeneration
  ) return;

  const result = combineBootCalibration({
    mic: micLeg,
    backing: leg,
    deltaMs: currentDeltaMs(nowMs),
    sampleRate: MIX_SAMPLE_RATE,
  });

  if (PROBE_DEBUG) {
    console.log(
      `[probe] combined advanceMs=${result.advanceMs.toFixed(0)}`
      + ` (mic ${result.micLatencyMs.toFixed(0)} - backing ${result.backingLatencyMs.toFixed(0)}`
      + ` + delta ${result.deltaMs.toFixed(0)}) confidence=${result.confidence.toFixed(3)}`,
    );
  }

  bootProbeRuntime.recordCalibration(bootProbeContext(), result);
  timingRuntime.markBootProbeAuthority();
  calibration.applyExternalResult({
    micLagMs: result.advanceMs,
    confidence: Math.max(0, Math.min(1, result.confidence)),
  });
}

function currentDeltaMs(nowMs: number) {
  return robotDeltaIsFresh(nowMs) ? robotPlayerOffset.offsetMs(nowMs)! : 0;
}

function maybeReapplyBootCalibration(nowMs: number) {
  if (takeBlocksCalibration()) return;
  if (!robotProbeTimingActive() || timingRuntime.calibrationKind !== 'boot-probe') return;
  if (bootProbeRuntime.pathDifferenceMs === null || calibration.collecting || calibration.transactionActive) return;
  if (!robotDeltaIsFresh(nowMs)) return;
  if (!bootProbeRuntime.completedContextMatches(bootProbeContext())) return;

  const advanceMs = bootProbeRuntime.pathDifferenceMs + currentDeltaMs(nowMs);
  const applied = session.alignment.calibratedMicLagMs;
  if (applied !== null && Math.abs(advanceMs - applied) < BOOT_DELTA_REAPPLY_MS) return;

  if (PROBE_DEBUG) {
    console.log(`[probe] delta moved; advanceMs ${applied?.toFixed(0) ?? 'none'} -> ${advanceMs.toFixed(0)}`);
  }
  bootProbeRuntime.reapplyCalibration(advanceMs, currentDeltaMs(nowMs));
  timingRuntime.markBootProbeAuthority();
  calibration.applyExternalResult({ micLagMs: advanceMs, confidence: bootProbeRuntime.confidence ?? 0 });
}

function dropLegacyCalibrationForRobot() {
  if (!robotProbeTimingActive() || timingRuntime.calibrationKind !== 'content') return;
  if (probeCalibrationExhausted()) return;
  clearContentValidationBaseline();
  calibration.reset();
  timingRuntime.clearCalibrationKind();
  timingRuntime.resetAutoCalibrationSchedule();
  syncAppliedCalibration();
}

// Command authority and product action availability stay in the command handler.
// Calibration, timing and probe state authority stay in their existing runtimes;
// this seam owns only the already-authorized manual transaction ordering.
const manualBootRecalibrationCoordinator = createRelayManualBootRecalibrationCoordinator({
  clearContentValidation: () => clearContentValidationBaseline(),
  beginExternalRecalibration: () => calibration.beginExternalRecalibration(),
  beginManualBootProbe: () => timingRuntime.beginBootProbe(false),
  abandonProbeRun: () => abandonProbeRun(),
  resetProbeCorrelations: () => bootProbeRuntime.resetCorrelations(),
  syncAppliedCalibration: () => syncAppliedCalibration(),
  maybeStartProbeCalibration: (nowMs) => maybeStartProbeCalibration(nowMs),
  reportTimingStatus: () => broadcastJson(timingCalibrationStatusPayload()),
  reportSourceStatus: () => broadcastJson(sourceStatusPayload()),
});

function restartManualBootCalibration(nowMs: number) {
  manualBootRecalibrationCoordinator.restart(nowMs);
}

const youtubeTimelineTimer = setInterval(() => {
  const nowMs = performance.now();

  if (youtubeTimeline.hasTelemetry) {
    broadcastJson(youtubeTimeline.statusPayload(nowMs));
    broadcastJson(youtubeTimeline.roomStatusPayload(nowMs));
  }

  const expiredRoomSongCommand = roomSongCommands.sweep(nowMs);
  if (expiredRoomSongCommand) {
    broadcastRoomSongCommandFailure(expiredRoomSongCommand.commandId, 'command-timeout', nowMs);
    broadcastJson(roomSongCommandStatusPayload(nowMs));
  }

  if (calibration.collecting) {
    const silent = silentSides(nowMs - COLLECTION_SILENCE_GRACE_MS);
    if (silent.length > 0) {
      calibration.fail(
        `Calibration stopped: no audio from the ${silent.join(' or ')}. `
        + 'Restart the backing source: on a development desktop the source page was probably reloaded, which drops the tab capture.',
      );
    } else if (!calibration.tick(nowMs)) {
      broadcastJson(timingCalibrationStatusPayload());
    }
  }

  if (session.active && nowMs - lastMixHealthAt >= MIX_HEALTH_INTERVAL_MS) {
    lastMixHealthAt = nowMs;
    broadcastJson(mixHealthPayload());
  }

  const pendingProbe = bootProbeRuntime.pendingRequest;
  if (pendingProbe !== null && nowMs - pendingProbe.serverSentAtMs > PROBE_REPLY_TIMEOUT_MS) {
    const expired = bootProbeRuntime.acceptReply(pendingProbe.requestId);
    if (expired) failProbeAttempt(expired.target, 'playback acknowledgement timed out', nowMs);
  }

  dropLegacyCalibrationForRobot();
  if (syncAppliedCalibration()) {
    broadcastJson(sourceStatusPayload());
    broadcastJson(timingCalibrationStatusPayload());
  }
  maybeFinishProbeAnalysis(nowMs);
  maybeStartProbeCalibration(nowMs);
  maybeReapplyBootCalibration(nowMs);
  sweepRobotContentTransition(nowMs);
  maybeAutoCalibrate(nowMs);
  maybeValidateContentCalibration(nowMs);

  sweepPreparedSongHandoff(nowMs);

  const presenceSweep = participants.sweep(Date.now());
  if (presenceSweep.releasedMicOwnerId && presenceSweep.micOwnerEffects) {
    applyMicOwnerEffects(presenceSweep.micOwnerEffects, nowMs, {
      afterQualityEvent: () => {
        micTransportGrace.cancel();
        clearMicMediaAuthority();
      },
      publishFullHandoffStatus: false,
    });
  }
  if (presenceSweep.changed) broadcastSessionStatus();

  broadcastProductStatus(nowMs);
}, 250);

function validSampleRate(value: unknown) {
  const sampleRate = Number(value);
  return Number.isFinite(sampleRate) && sampleRate >= 8_000 && sampleRate <= 192_000
    ? sampleRate
    : null;
}

function validCaptureGeneration(value: unknown) {
  const generation = Number(value);
  return Number.isInteger(generation) && generation >= 0 && generation <= 0xffff_ffff
    ? generation >>> 0
    : null;
}

function validAudioPacketVersion(value: unknown): 1 | 2 | null {
  if (value === undefined || value === null) return 1;
  const version = Number(value);
  return version === 1 || version === 2 ? version : null;
}

const queryProtocol = createRelayQueryProtocol<RelaySocket>({
  sendJson,
  sessionStatusPayload: () => sessionStatusPayload(),
  productStatusPayload: () => productStatusPayload(),
  takeStatusPayload: () => takeController.statusPayload(),
  roomSongStatusPayload: () => youtubeTimeline.roomStatusPayload(),
  roomSongCommandStatusPayload: () => roomSongCommandStatusPayload(),
  youtubeTimelineStatusPayload: () => youtubeTimeline.statusPayload(),
  sourceStatusPayload: () => sourceStatusPayload(),
  timingCalibrationStatusPayload: () => timingCalibrationStatusPayload(),
});

const micReleaseCoordinator = createRelayMicReleaseCoordinator<
  RelaySocket,
  Parameters<typeof applyMicOwnerTransitionEffects>[0]
>({
  publisherParticipantId: () => micRuntime.publisher?.participantId ?? null,
  mediaOwnerId: () => micRuntime.mediaOwnerId,
  revokePublisherTransport: (message) => revokePublisherTransport(message),
  clearMediaAuthority: () => clearMicMediaAuthority(),
  cancelTransportGrace: () => micTransportGrace.cancel(),
  applyOwnershipEffects: (effects, hooks) => {
    applyMicOwnerEffects(effects, performance.now(), {
      afterQualityEvent: hooks.afterQualityEvent,
      beforeTimingInvalidation: hooks.beforeTimingInvalidation,
    });
  },
  broadcastSessionStatus: () => broadcastSessionStatus(),
  sendReleased: (socket) => sendJson(socket, { type: 'mic-released' }),
});

// Participant/product admission and take-id validation stay in the command handler.
// TakeController remains recording/storage authority; this seam owns only admitted
// command ordering around the authoritative mix-frame boundary.
const takeCommandCoordinator = createRelayTakeCommandCoordinator<
  RelaySocket,
  ReturnType<typeof takeFrameBoundary>['position'],
  TakeSongSnapshot
>({
  frameBoundary: (nowMs) => takeFrameBoundary(nowMs),
  songSnapshot: (atMs) => takeSongSnapshot(atMs),
  cancelActiveContentValidation: (nowMs) => cancelActiveContentValidation(nowMs),
  reportTimingStatus: () => broadcastJson(timingCalibrationStatusPayload()),
  startTake: (participantId, song, position, wallClockMs) =>
    takeController.start(participantId, song, position, wallClockMs),
  stopTake: (takeId, participantId, position, reason, wallClockMs) =>
    takeController.stop(takeId, participantId, position, reason, wallClockMs),
  reject: (socket, command, reason) => rejectTakeCommand(socket, command, reason),
  acceptStart: (socket, takeId) => {
    sendJson(socket, {
      type: 'take-command-accepted',
      command: 'start',
      takeId,
    });
  },
  acceptStop: (socket, takeId, duplicate) => {
    sendJson(socket, {
      type: 'take-command-accepted',
      command: 'stop',
      takeId,
      duplicate,
    });
  },
});

const youtubeTelemetryAcceptanceCoordinator = createRelayYoutubeTelemetryAcceptanceCoordinator<RelaySocket, PlaybackIdentity>({
  registerPlayback: (socket, identity) => { playbackTransport.register(socket, identity); },
  clearTelemetryRejection: (socket) => { socket.telemetryRejectedReason = undefined; },
  cancelActiveContentValidation: (nowMs) => cancelActiveContentValidation(nowMs),
  reportTimingStatus: () => broadcastJson(timingCalibrationStatusPayload()),
  reportTimelineStatus: (status) => broadcastJson(status),
  reportRoomStatus: (nowMs) => broadcastJson(youtubeTimeline.roomStatusPayload(nowMs)),
  completeRoomSongCommand: (commandId) => roomSongCommands.complete(commandId),
  reportRoomSongCommandComplete: (commandId) => {
    broadcastJson({
      type: 'room-song-command-complete',
      commandId,
      revision: roomSongCommands.revision,
    });
  },
  reportRoomSongCommandStatus: (nowMs) => broadcastJson(roomSongCommandStatusPayload(nowMs)),
  releasePreviousLeader: (previousLeader, handoffId, videoId) => {
    playbackTransport.send(previousLeader, {
      type: 'song-handoff-release',
      handoffId,
      videoId,
    });
  },
  completeHandoff: (identity, handoffId) => {
    playbackTransport.send(identity, {
      type: 'song-handoff-complete',
      handoffId,
    });
  },
});

const commandProtocol = createRelayCommandProtocol<RelaySocket>({
  startTake: (socket) => {
    if (!socket.participantId) {
      rejectTakeCommand(socket, 'start', 'participant-required');
      return;
    }
    const commandWallClockMs = Date.now();
    const nowMs = performance.now();
    const productStatus = productStatusPayload(nowMs);
    if (!productStatus.actions.canStartTake) {
      const blockedReason = productStatus.actions.startTakeBlockedReason;
      if (blockedReason === null) {
        rejectTakeCommand(socket, 'start', 'product-state-invalid');
        return;
      }
      rejectTakeCommand(socket, 'start', blockedReason);
      return;
    }

    takeCommandCoordinator.start({
      socket,
      participantId: socket.participantId,
      commandWallClockMs,
      nowMs,
    });
    return;
  },
  stopTake: (socket, payload) => {
    if (!socket.participantId) {
      rejectTakeCommand(socket, 'stop', 'participant-required');
      return;
    }
    const takeId = typeof payload.takeId === 'string' ? payload.takeId.trim() : '';
    if (!TAKE_ID_PATTERN.test(takeId)) {
      rejectTakeCommand(socket, 'stop', 'invalid-take-id');
      return;
    }

    const commandWallClockMs = Date.now();
    const nowMs = performance.now();
    takeCommandCoordinator.stop({
      socket,
      participantId: socket.participantId,
      takeId,
      commandWallClockMs,
      nowMs,
    });
    return;
  },
  releaseMic: (socket) => {
    if (!socket.participantId) return;
    const result = participants.releaseMic(socket.participantId);
    if (!result.ok) return;

    micReleaseCoordinator.release({
      socket,
      participantId: socket.participantId,
      effects: result.effects,
    });
  },
  roomSongCommand: (socket, payload) => {
    if (!socket.participantId) {
      rejectRoomSongCommand(socket, payload.commandId, 'participant-required');
      return;
    }

    const playbackIdentity = playbackTransport.identity(socket);
    if (!playbackIdentity || playbackIdentity.participantId !== socket.participantId) {
      rejectRoomSongCommand(socket, payload.commandId, 'playback-transport-required');
      return;
    }

    const parsed = parseRoomSongCommand(payload);
    if (!parsed.ok) {
      rejectRoomSongCommand(socket, payload.commandId, parsed.reason);
      return;
    }

    const nowMs = performance.now();
    const decision = roomSongCommands.begin(
      parsed.request,
      socket.participantId,
      playbackIdentity,
      participants.micOwnerId,
      youtubeTimeline.statusPayload(nowMs) as Record<string, unknown>,
      nowMs,
    );
    if (!decision.ok) {
      rejectRoomSongCommand(socket, parsed.request.commandId, decision.reason);
      return;
    }

    sendJson(socket, {
      type: 'room-song-command-accepted',
      commandId: decision.command.commandId,
      revision: decision.command.revision,
      duplicate: decision.duplicate,
    });

    const commandTarget = decision.command.target;
    const stillPending = roomSongCommands.pendingForTarget(commandTarget, nowMs);
    if (stillPending?.commandId === decision.command.commandId) {
      playbackTransport.send(commandTarget, roomSongCommandApplyPayload(decision.command));
    }
    broadcastJson(roomSongCommandStatusPayload(nowMs));
  },
  roomSongCommandFailed: (socket, payload) => {
    const playbackIdentity = playbackTransport.identity(socket);
    if (!playbackIdentity) return;
    const nowMs = performance.now();
    const pendingCommand = roomSongCommands.pendingForTarget(playbackIdentity, nowMs);
    if (
      pendingCommand
      && payload.commandId === pendingCommand.commandId
      && roomSongCommands.fail(playbackIdentity, pendingCommand.commandId)
    ) {
      broadcastRoomSongCommandFailure(pendingCommand.commandId, 'playback-failed', nowMs);
      broadcastJson(roomSongCommandStatusPayload(nowMs));
    }
  },
  songHandoffReady: (socket, payload) => {
    const playbackIdentity = playbackTransport.identity(socket);
    if (!playbackIdentity) return;
    const plan = youtubeTimeline.markHandoffReady(
      playbackIdentity,
      payload.handoffId,
      participants.micOwnerId,
    );
    if (!plan) return;
    sendHandoffPlan('song-handoff-commit', plan);
    broadcastJson(youtubeTimeline.statusPayload());
    broadcastJson(youtubeTimeline.roomStatusPayload());
  },
  songHandoffFailed: (socket, payload) => {
    const playbackIdentity = playbackTransport.identity(socket);
    if (!playbackIdentity) return;
    if (youtubeTimeline.deferHandoff(playbackIdentity, payload.handoffId)) {
      broadcastJson(youtubeTimeline.statusPayload());
      broadcastJson(youtubeTimeline.roomStatusPayload());
    }
  },
  participantRename: (socket, payload) => {
    if (!socket.participantId) return;
    if (participants.rename(socket.participantId, payload.nickname, Date.now())) {
      broadcastSessionStatus();
    } else {
      sendJson(socket, sessionStatusPayload());
    }
  },
  rejectMicReservation: (socket) => {
    sendJson(socket, {
      type: 'error',
      message: 'Microphone ownership is committed by publisher registration, not reserved separately.',
    });
  },
  playbackMicIntent: (socket) => {
    const playbackIdentity = playbackTransport.identity(socket);
    if (!playbackIdentity || playbackIdentity.participantId !== socket.participantId) return;
    playbackTransport.noteMicIntent(socket, performance.now());
    sendJson(socket, { type: 'playback-mic-intent-registered' });
  },
  playbackHello: (socket, payload) => {
    if (!socket.participantId) return;
    const transportId = normalizePlaybackTransportId(payload.playbackTransportId);
    const generation = normalizePlaybackGeneration(payload.playbackGeneration);
    if (!transportId || generation === null) {
      sendJson(socket, { type: 'error', message: 'Invalid playback transport identity.' });
      return;
    }

    const playbackIdentity = playbackTransport.register(socket, {
      participantId: socket.participantId,
      transportId,
      generation,
    });
    sendJson(socket, { type: 'playback-registered', playbackTransportId: transportId, playbackGeneration: generation });
    sendJson(socket, youtubeTimeline.roomStatusPayload());
    sendJson(socket, roomSongCommandStatusPayload());

    const pendingPlan = playbackIdentity
      ? youtubeTimeline.handoffPlanForTarget(playbackIdentity)
      : null;
    if (pendingPlan) sendHandoffPlan('song-handoff-prepare', pendingPlan);

    const pendingCommand = playbackIdentity
      ? roomSongCommands.pendingForTarget(playbackIdentity, performance.now())
      : null;
    if (pendingCommand) playbackTransport.send(playbackIdentity!, roomSongCommandApplyPayload(pendingCommand));
    return;
  },
  youtubeTelemetry: (socket, payload) => {
    const registeredPlaybackIdentity = playbackTransport.identity(socket);
    let playbackParticipantId = socket.participantId;
    let playbackTransportId = registeredPlaybackIdentity?.transportId
      ?? normalizePlaybackTransportId(payload.playbackTransportId);
    let playbackGeneration = registeredPlaybackIdentity?.generation
      ?? normalizePlaybackGeneration(payload.playbackGeneration);

    if (!playbackParticipantId) {
      if (!micRuntime.isPublisher(socket)) {
        reportTelemetryRejected(socket, 'not-publisher');
        return;
      }
      playbackParticipantId = LEGACY_PLAYBACK_PARTICIPANT_ID;
      playbackTransportId = LEGACY_PLAYBACK_TRANSPORT_ID;
      playbackGeneration = socket.connectionIncarnation;
    } else if (!playbackTransportId || playbackGeneration === null) {
      reportTelemetryRejected(socket, 'invalid-identity');
      return;
    }

    const acceptedIdentity = {
      participantId: playbackParticipantId,
      transportId: playbackTransportId,
      generation: playbackGeneration,
    };
    const nowMs = performance.now();
    const commandGate = roomSongCommands.gateTelemetry(
      payload,
      acceptedIdentity,
      youtubeTimeline.statusPayload(nowMs) as Record<string, unknown>,
      nowMs,
    );
    if (!commandGate.ok) {
      reportRoomSongTelemetryRejected(socket, commandGate.reason);
      return;
    }

    const result = youtubeTimeline.update(
      payload,
      acceptedIdentity,
      participants.micOwnerId,
      nowMs,
    );
    if (result.accepted) {
      const timelineStatus = youtubeTimeline.statusPayload(nowMs);
      youtubeTelemetryAcceptanceCoordinator.accept({
        socket,
        acceptedIdentity,
        nowMs,
        timelineStatus,
        completesCommandId: commandGate.completesCommandId,
        handoffCompleted: result.handoffCompleted,
        handoffId: result.handoffId,
        previousLeader: result.previousLeader,
      });
    } else {
      reportTelemetryRejected(socket, result.reason ?? 'invalid-telemetry');
    }
    return;
  },

  setVocalFineTune: (socket, payload) => {
    if (!requireMicOwnerCommand(socket, 'set-vocal-fine-tune')) return;
    const nextFineTune = Number(payload.valueMs);
    if (Number.isFinite(nextFineTune)) {
      session.setAlignment({
        fineTuneMs: Math.max(-MAX_VOCAL_FINE_TUNE_MS, Math.min(MAX_VOCAL_FINE_TUNE_MS, nextFineTune)),
      });
      broadcastJson(sourceStatusPayload());
      broadcastJson(timingCalibrationStatusPayload());
    }
    return;
  },
  setMix: (socket, payload) => {
    if (!requireMicOwnerCommand(socket, 'set-mix')) return;
    const nextGain = Number(payload.micGainDb);
    if (Number.isFinite(nextGain)) {
      session.setMicGainDb(Math.max(0, Math.min(MAX_MIC_GAIN_DB, nextGain)));
    }
    // `songLevel` remains accepted on the old wire shape for compatibility,
    // but Song is now a server-owned 100% reference and cannot be mutated by
    // any client authority.
    broadcastJson(mixSettingsPayload());
    return;
  },
  audioUplinkHealth: (socket, payload) => {
    const health = parseAudioUplinkHealth(payload);
    if (health) micRuntime.noteUplinkHealth(socket, health, performance.now());
    return;
  },
  micPresenceTelemetry: (socket, payload) => {
    const presence = parseMicPresenceTelemetry(payload);
    const nowMs = performance.now();
    if (
      !presence
      || !socket.participantId
      || socket.participantId !== participants.micOwnerId
      || socket.participantId !== micRuntime.mediaOwnerId
      || micRuntime.mediaGeneration === null
      || presence.captureGeneration !== micRuntime.mediaGeneration
      || !micStreaming(nowMs)
    ) return;

    // Presence is display telemetry, not media authority. Any authenticated
    // socket for the current Mic owner may report it, but the server binds the
    // packet to the canonical media generation and rate-limits broadcast.
    if (
      Number.isFinite(socket.micPresenceTelemetryAt)
      && nowMs - socket.micPresenceTelemetryAt! < 60
    ) return;
    socket.micPresenceTelemetryAt = nowMs;
    broadcastJson({
      type: 'room-mic-presence',
      version: 1,
      ownerId: micRuntime.mediaOwnerId,
      captureGeneration: micRuntime.mediaGeneration,
      rmsDbfs: presence.rmsDbfs,
      spectrumBands: presence.spectrumBands,
      f0Hz: presence.f0Hz,
      pitchConfidence: presence.pitchConfidence,
    });
    return;
  },
  startTimingCalibration: (socket) => {
    if (!requireMicOwnerCommand(socket, 'start-timing-calibration')) return;
    const nowMs = performance.now();
    const calibrationAction = productStatusPayload(nowMs).actions;
    if (!calibrationAction.canStartCalibration) {
      switch (calibrationAction.startCalibrationBlockedReason) {
        case 'take-active':
          sendJson(socket, {
            type: 'calibration-command-rejected',
            reason: 'take-active',
          });
          return;
        case 'calibration-active':
          sendJson(socket, timingCalibrationStatusPayload());
          return;
        case 'sources-not-connected':
          calibration.fail('Connect both phone Microphone and Desktop Source before calibration.');
          return;
        case 'sources-not-streaming': {
          const silent = silentSides(nowMs);
          calibration.fail(
            `No audio arriving from the ${silent.join(' or ')}. `
            + 'Restart the backing source: on a development desktop the source page was probably reloaded, which drops the tab capture.',
          );
          return;
        }
        case 'phone-not-playing':
          calibration.fail('Play YouTube on the phone before calibration.');
          return;
      }
      return;
    }

    if (calibrationAction.startCalibrationMode === 'boot-probe') {
      restartManualBootCalibration(nowMs);
      return;
    }

    cancelActiveContentValidation(nowMs);
    timingRuntime.beginContentCalibration(nowMs, false);
    calibration.start(nowMs);
    broadcastJson(timingCalibrationStatusPayload());
    return;
  },

});

const infrastructureEventProtocol = createRelayInfrastructureEventProtocol<RelaySocket>({
  backingSampleBoundary: (socket, payload) => {
    if (!backingRuntime.isSocket(socket) || socket.role !== 'backing' || !backingRuntime.isRobot) return;
    const requestId = Number(payload.requestId);
    const generation = validCaptureGeneration(payload.generation);
    const firstSampleIndex = Number(payload.firstSampleIndex);
    // This ACK is only a capture-transport lower bound. It deliberately does
    // not call noteBackingBoundary(): Browser/PipeWire may still deliver old
    // music after this cursor. The next binary frames translate this capture
    // cursor into the session timeline, then PCM evidence proves the segment.
    robotContentTransitionRuntime.acceptBackingBoundary({
      requestId,
      generation,
      firstSampleIndex,
      currentBackingGeneration: session.backingGeneration,
      context: calibrationContext(),
    });
    return;
  },
  robotPlayerOffset: (socket, payload) => {
    const offsetMs = Number(payload.offsetMs);
    if (sourceRuntime.isActiveRobot(socket) && Number.isFinite(offsetMs)) {
      const nowMs = performance.now();
      robotPlayerOffset.record(offsetMs, nowMs);
      const mapped = robotContentTimeline.notePlayerOffset(
        robotPlayerOffset.offsetMs(nowMs) ?? offsetMs,
        calibrationContext(),
        nowMs,
      );
      if (mapped) requestRobotBackingBoundary(nowMs);
    }
    return;
  },
  calibrationProbe: (socket, payload) => {
    const fromPublisher = micRuntime.isPublisher(socket);
    const target = payload.target === 'backing' ? 'backing' : 'mic';
    const fromActiveRobot = sourceRuntime.isActiveRobot(socket);
    if (target === 'mic' ? fromPublisher : fromActiveRobot) {
      const nowMs = performance.now();
      if (payload.type === 'calibration-probe-played') {
        handleProbeReply({ requestId: payload.requestId, generation: payload.generation }, nowMs);
      } else {
        handleProbeFailure(
          { requestId: payload.requestId, generation: payload.generation, reason: payload.reason },
          nowMs,
        );
      }
    }
    return;
  },
  sourceSeeked: (socket, payload) => {
    if (!infrastructureCapability.authorized(socket)) {
      rejectInfrastructure(socket, 'Authenticate the active Source before reporting a seek.');
      return;
    }
    // `isRobotSource` is intentionally tri-state here: undefined means this
    // socket was never a Robot source, while true/false means it has entered
    // the Robot source lifecycle. Replacement clears the active flag to
    // false, but must not restore seek authority to that old socket.
    if (!sourceRuntime.canReportSeek(socket)) return;
    const nowMs = performance.now();
    robotContentTransitionRuntime.clearPendingBoundary();
    const requestedFollowerCorrection = payload.reason === 'follower-correction';
    const fromMediaTime = Number(payload.fromMediaTime);
    const toMediaTime = Number(payload.toMediaTime);
    const context = calibrationContext();
    const preDeltaMs = robotContentTimeline.currentDeltaMs;
    const referenceDeltaMs = robotContentTimeline.referenceDeltaMs;
    const mappedFollowerCorrection = requestedFollowerCorrection
      && sourceRuntime.isActiveRobot(socket)
      && backingRuntime.isRobot
      && robotContentTimeline.noteFollowerCorrection(
        fromMediaTime,
        toMediaTime,
        context,
        nowMs,
      );

    robotPlayerOffset.reset();
    if (mappedFollowerCorrection) {
      if (preDeltaMs !== null && referenceDeltaMs !== null) {
        beginRobotContentTransition(
          fromMediaTime,
          toMediaTime,
          preDeltaMs,
          referenceDeltaMs,
          context,
          nowMs,
        );
      }
      // Same source/capture identity, different media mapping segment. Keep the
      // transaction and primed evidence, but immediately rebase any already
      // confirmed content authority onto the post-seek player delta (zero).
      syncAppliedCalibration();
      broadcastJson(sourceStatusPayload());
      broadcastJson(timingCalibrationStatusPayload());
      return;
    }

    // A load/manual seek, legacy no-reason event, or a follower correction
    // without concrete from/to media positions is destructive. Ambiguous old
    // Source pages fail closed instead of smuggling a mapping break through as
    // continuous calibration evidence.
    clearRobotContentTransition();
    sourceRuntime.invalidateMapping();
    clearContentValidationBaseline();
    calibration.discardPrimedContent();
    robotContentTimeline.reset();
    if (calibration.collecting) {
      calibration.fail('The desktop player seeked during calibration. Start calibration again.');
    } else {
      syncAppliedCalibration();
      broadcastJson(sourceStatusPayload());
      broadcastJson(timingCalibrationStatusPayload());
    }
    return;
  },
});

const authenticationProtocol = createRelayAuthenticationProtocol<RelaySocket>({
  infrastructureAuthenticate: (socket, payload) => {
    if (!infrastructureCapability.authenticate(socket, payload.key)) {
      rejectInfrastructure(
        socket,
        'Infrastructure capability did not match this Relay deployment.',
      );
      return;
    }
    sendJson(socket, { type: 'infrastructure-authenticated' });
    return;
  },
  participantAuthenticate: (socket, payload) => {
    const authenticated = participantIdentityFromAuthentication(payload);
    if (
      authenticated.kind !== 'valid'
      || infrastructureCapability.authenticated(socket)
      || (socket.participantId !== undefined && socket.participantId !== authenticated.participantId)
    ) {
      sendJson(socket, {
        type: 'participant-auth-rejected',
        message: 'Participant identity did not match its private browser capability. Reload Relay.',
      });
      socket.close(1008, 'Participant capability mismatch.');
      return;
    }
    attachParticipantIdentity(socket, authenticated);
    sendJson(socket, {
      type: 'participant-authenticated',
      participantId: authenticated.participantId,
    });
    return;
  },
});

const publisherActivationCoordinator = createRelayPublisherActivationCoordinator<
  RelaySocket,
  Parameters<typeof applyMicOwnerTransitionEffects>[0]
>({
  now: () => performance.now(),
  participantId: (socket) => socket.participantId ?? null,
  applyOwnershipEffects: (effects, hooks) => {
    applyMicOwnerEffects(effects, performance.now(), {
      invalidateTiming: hooks.invalidateTiming,
      prepareSongHandoff: hooks.prepareSongHandoff,
    });
  },
  bindPublisher: (registration) => micRuntime.bindPublisher(registration),
  retirePrevious: (previousPublisher, nextPublisher, sameParticipantReplacement) => {
    const newOwnerName = nextPublisher.participantId
      ? participantPayload(nextPublisher.participantId)?.nickname ?? 'Another participant'
      : 'Another microphone';
    retirePublisherTransport(
      previousPublisher,
      sameParticipantReplacement ? 'publisher-superseded' : 'mic-revoked',
      sameParticipantReplacement
        ? 'A newer microphone capture from this participant became active.'
        : `${newOwnerName} took over the microphone.`,
    );
  },
  cancelTransportGrace: () => micTransportGrace.cancel(),
  setMicExpected: () => session.setMicExpected(true),
  sessionActive: () => session.active,
  noteTransportConnected: () => takeController.noteQualityEvent('mic-transport-connected'),
  invalidateTiming: (reason) => invalidateMicTiming(reason),
  restartLiveSource: () => restartLiveSourceAfterMicReconnect(),
  directMediaOffer: () => micRuntime.directMediaOffer(),
  sendRegistered: (socket, result) => {
    sendJson(socket, {
      type: 'registered',
      role: 'publisher',
      takeover: result.takeover,
      ...(result.mediaTransport ? { mediaTransport: result.mediaTransport } : {}),
    });
  },
  sendInitialState: (socket) => {
    sendJson(socket, mixSettingsPayload());
    sendJson(socket, youtubeTimeline.statusPayload());
    sendJson(socket, youtubeTimeline.roomStatusPayload());
    sendJson(socket, roomSongCommandStatusPayload());
    sendJson(socket, takeController.statusPayload());
    sendJson(socket, sourceStatusPayload());
    sendJson(socket, timingCalibrationStatusPayload());
  },
  broadcastStatus: () => broadcastStatus(),
  broadcastSessionStatus: () => broadcastSessionStatus(),
  beginPreparedSongHandoff: (participantId) => beginPreparedSongHandoff(participantId),
});

const backingActivationCoordinator = createRelayBackingActivationCoordinator<RelaySocket>({
  previousBacking: () => backingRuntime.socket,
  clearRobotBackingBoundaryRequest: () => clearRobotBackingBoundaryRequest(),
  noteQualityEvent: (event) => takeController.noteQualityEvent(event),
  retirePrevious: (previous, next) => {
    replacePrevious(previous, next, 'Replaced by a newer tab capture.');
  },
  setSocketSampleRate: (socket, sampleRate) => {
    socket.sampleRate = sampleRate;
  },
  bindBacking: (registration) => backingRuntime.bind(registration),
  setBackingExpected: () => session.setBackingExpected(true),
  sessionActive: () => session.active,
  dropLegacyCalibrationForRobot: () => dropLegacyCalibrationForRobot(),
  activeBackingIsRobot: () => backingRuntime.isRobot,
  sendRegistered: (socket, robot) => {
    sendJson(socket, { type: 'registered', role: 'backing', robot });
  },
  startLiveSource: () => startLiveSource(),
});

const registrationProtocol = createRelayRegistrationProtocol<RelaySocket>({
  publisher: (socket, payload) => {
    if (!canClaimSocketRole(socket, 'publisher')) return;
    // A publisher is the microphone media authority. Browser clients must
    // authenticate that authority before registration; anonymous publishers
    // remain available only to the explicitly enabled legacy test harness.
    if (!socket.participantId && !legacyTestParticipantIdentityEnabled()) {
      sendJson(socket, {
        type: 'participant-auth-rejected',
        message: 'Authenticate this Relay participant before registering the microphone.',
      });
      socket.close(1008, 'Participant authentication required.');
      return;
    }

    const sampleRate = validSampleRate(payload.sampleRate);
    if (!sampleRate) {
      sendJson(socket, { type: 'error', message: 'Invalid sample rate.' });
      return;
    }

    const captureGeneration = validCaptureGeneration(payload.captureGeneration);
    const initialSequence = payload.initialSequence === undefined
      ? undefined
      : validCaptureGeneration(payload.initialSequence);
    const audioPacketVersion = validAudioPacketVersion(payload.audioPacketVersion);
    if (!audioPacketVersion) {
      sendJson(socket, { type: 'error', message: 'Unsupported audio packet version.' });
      return;
    }
    if (audioPacketVersion === 2 && captureGeneration === null) {
      sendJson(socket, {
        type: 'error',
        message: 'AudioPacket v2 requires a capture generation in publisher registration.',
      });
      return;
    }
    if (audioPacketVersion === 2 && initialSequence === null) {
      sendJson(socket, {
        type: 'error',
        message: 'AudioPacket v2 initial sequence must be a uint32 when provided.',
      });
      return;
    }
    const hasTakeoverExpectation = Object.prototype.hasOwnProperty.call(payload, 'takeoverExpectedOwnerId');
    const expectedOwnerId = hasTakeoverExpectation
      ? normalizeParticipantId(payload.takeoverExpectedOwnerId)
      : null;

    if (
      hasTakeoverExpectation
      && payload.takeoverExpectedOwnerId !== null
      && !expectedOwnerId
    ) {
      sendJson(socket, {
        type: 'mic-takeover-rejected',
        reason: 'owner-changed',
        owner: participantPayload(participants.micOwnerId),
        revision: participants.revision,
      });
      sendJson(socket, sessionStatusPayload());
      return;
    }

    let ownershipEffects: Parameters<typeof applyMicOwnerTransitionEffects>[0] | null = null;
    let previousOwnerId: string | null = participants.micOwnerId;
    if (socket.participantId) {
      const ownership = hasTakeoverExpectation
        ? participants.takeoverMic(socket.participantId, expectedOwnerId)
        : participants.acquireMic(socket.participantId);
      if (!ownership.ok) {
        if (ownership.reason === 'busy') {
          sendJson(socket, {
            type: 'mic-busy',
            owner: participantPayload(ownership.ownerId),
            revision: participants.revision,
          });
        } else {
          sendJson(socket, {
            type: 'mic-takeover-rejected',
            reason: ownership.reason,
            owner: participantPayload(ownership.ownerId),
            revision: participants.revision,
          });
        }
        sendJson(socket, sessionStatusPayload());
        return;
      }
      ownershipEffects = ownership.effects;
      previousOwnerId = ownership.previousOwnerId;
    } else if (participants.micOwnerId !== null) {
      sendJson(socket, { type: 'error', message: 'Microphone is owned by an active Relay participant.' });
      return;
    }

    commitSocketRole(socket, 'publisher');


    publisherActivationCoordinator.activate({
      socket,
      ownershipEffects,
      previousOwnerId,
      takeoverRequested: hasTakeoverExpectation,
      sampleRate,
      captureGeneration,
      initialSequence: initialSequence ?? undefined,
      audioPacketVersion,
    });
    return;
  },
  backing: (socket, payload) => {
    if (!infrastructureCapability.authorized(socket)) {
      rejectInfrastructure(socket, 'Authenticate Relay infrastructure before registering backing audio.');
      return;
    }
    if (!canClaimSocketRole(socket, 'backing')) return;
    const sampleRate = validSampleRate(payload.sampleRate);
    if (!sampleRate) {
      sendJson(socket, { type: 'error', message: 'Invalid backing sample rate.' });
      return;
    }

    commitSocketRole(socket, 'backing');

    backingActivationCoordinator.activate({
      socket,
      sampleRate,
      robot: payload.robot === true,
    });
    return;
  },
  monitor: (socket, payload) => {
    if (!socket.participantId && !infrastructureCapability.authorized(socket)) {
      rejectInfrastructure(socket, 'Monitor audio requires a Relay participant or infrastructure capability.');
      return;
    }
    if (!canClaimSocketRole(socket, 'monitor')) return;

    const requestedMonitorPacketVersion = payload.monitorPacketVersion;
    const monitorPacketVersion = requestedMonitorPacketVersion === undefined
      || requestedMonitorPacketVersion === null
      ? undefined
      : Number(requestedMonitorPacketVersion) === 1
        ? 1
        : null;
    if (monitorPacketVersion === null) {
      sendJson(socket, { type: 'error', message: 'Unsupported monitor packet version.' });
      return;
    }

    commitSocketRole(socket, 'monitor');
    socket.monitorPacketVersion = monitorPacketVersion;
    sendJson(socket, {
      type: 'registered',
      role: 'monitor',
      ...(monitorPacketVersion ? { monitorPacketVersion } : {}),
    });
    sendJson(socket, publisherStatusPayload());
    sendJson(socket, sourceStatusPayload());
    sendJson(socket, timingCalibrationStatusPayload());
    sendJson(socket, mixSettingsPayload());
    sendJson(socket, youtubeTimeline.statusPayload());
    sendJson(socket, youtubeTimeline.roomStatusPayload());
    sendJson(socket, roomSongCommandStatusPayload());
    sendJson(socket, takeController.statusPayload());
    if (socket.participantId) sendJson(socket, sessionStatusPayload());
    return;
  },
});

const robotActivationCoordinator = createRelayRobotActivationCoordinator<RelaySocket>({
  notifyPreviousReplaced: (previous) => {
    sendJson(previous, { type: 'robot-source-replaced' });
  },
  noteQualityEvent: (event) => takeController.noteQualityEvent(event),
  abandonProbeRun: () => abandonProbeRun(),
  sessionActive: () => session.active,
  resetPlayerOffset: () => robotPlayerOffset.reset(),
  resetContentTimeline: () => robotContentTimeline.reset(),
  clearBackingBoundaryRequest: () => clearRobotBackingBoundaryRequest(),
  dropLegacyCalibrationForRobot: () => dropLegacyCalibrationForRobot(),
  syncAppliedCalibration: () => { syncAppliedCalibration(); },
  reportSourceStatus: () => broadcastJson(sourceStatusPayload()),
  reportTimingStatus: () => broadcastJson(timingCalibrationStatusPayload()),
});

const robotLifecycleProtocol = createRelayRobotLifecycleProtocol<RelaySocket>({
  robotSourceHello: (socket, payload) => {
    if (!infrastructureCapability.authorized(socket)) {
      rejectInfrastructure(socket, 'Authenticate Relay infrastructure before becoming the Robot source.');
      return;
    }
    if (sourceRuntime.isActive(socket)) return;

    const { previous, replaced } = sourceRuntime.attachRobot(socket);
    robotActivationCoordinator.activate({ previous, replaced });
    return;
  },
});

const backingCaptureRestartCoordinator = createRelayBackingCaptureRestartCoordinator({
  clearBackingBoundaryRequest: () => clearRobotBackingBoundaryRequest(),
  noteQualityEvent: (event) => takeController.noteQualityEvent(event),
  abandonProbeRun: () => abandonProbeRun(),
  clearContentValidation: () => clearContentValidationBaseline(),
  failCalibration: (message) => calibration.fail(message),
  syncAppliedCalibration: () => { syncAppliedCalibration(); },
  reportTimingStatus: () => broadcastJson(timingCalibrationStatusPayload()),
  reportSourceStatus: () => broadcastJson(sourceStatusPayload()),
});

const audioUplinkCoordinator = createRelayAudioUplinkCoordinator<RelaySocket>({
  isMicPublisher: (socket) => micRuntime.isPublisher(socket),
  receiveMic: (socket, data, nowMs) => {
    deliverMicPackets(micRuntime.receivePublisher(socket, data, nowMs));
  },
  isBackingActive: (socket) => (
    backingRuntime.isSocket(socket) && socket.role === 'backing' && session.active
  ),
  decodeBacking: (data) => decodePcmFrame(data),
  backingGeneration: () => session.backingGeneration,
  now: () => performance.now(),
  noteBackingFrame: (socket, nowMs) => backingRuntime.noteFrame(socket, nowMs),
  ingestBacking: (frame, nowMs) => session.ingestBacking(
    frame,
    backingRuntime.sampleRate,
    nowMs,
    backingRuntime.isRobot,
  ),
  onBackingCaptureRestarted: () => {
    backingCaptureRestartCoordinator.restart({
      calibrationCollecting: calibration.collecting,
    });
  },
  noteRobotTransitionBackingFrame: (frame, samples, start, nowMs) => {
    noteRobotTransitionBackingFrame(frame, samples, start, nowMs);
  },
  mappedContentBackingStart: (start, nowMs) => mappedContentBackingStart(start, nowMs),
  feedContentBackingEvidence: (samples, start, nowMs) => {
    feedContentBackingEvidence(samples, start, nowMs);
  },
});
const robotDisconnectCoordinator = createRelayRobotDisconnectCoordinator<RelaySocket>({
  isActive: (socket) => sourceRuntime.isActive(socket),
  noteDisconnected: () => takeController.noteQualityEvent('robot-source-disconnected'),
  detach: (socket) => sourceRuntime.detachRobot(socket),
  resetPlayerOffset: () => robotPlayerOffset.reset(),
  resetContentTimeline: () => robotContentTimeline.reset(),
  clearBackingBoundaryRequest: () => clearRobotBackingBoundaryRequest(),
  abandonProbeRun: () => abandonProbeRun(),
  syncAppliedCalibration: () => syncAppliedCalibration(),
  reportSourceStatus: () => broadcastJson(sourceStatusPayload()),
  reportTimingStatus: () => broadcastJson(timingCalibrationStatusPayload()),
});
const micDisconnectCoordinator = createRelayMicDisconnectCoordinator<RelaySocket>({
  isPublisher: (socket) => micRuntime.isPublisher(socket),
  noteDisconnected: () => takeController.noteQualityEvent('mic-transport-disconnected'),
  reconnectingOwnerId: (socket) => socket.participantId
    && participants.micOwnerId === socket.participantId
    ? socket.participantId
    : null,
  detachPublisher: (socket) => micRuntime.detachPublisher(socket),
  clearMediaAuthority: () => clearMicMediaAuthority(),
  preserveMediaForReconnect: (ownerId) => {
    // The control plane may reconnect while an independent HTTP/3 media
    // session is still carrying the same capture. Keep the capture and
    // sample rate authoritative until the existing grace expires.
    const directMediaStillLive = webTransportMicConnected();
    session.setMicExpected(directMediaStillLive);
    micTransportGrace.schedule(ownerId);
  },
  maybeStopLiveSourceWhenUnarmed: () => maybeStopLiveSourceWhenUnarmed(),
  failCalibrationIfCollecting: () => {
    if (calibration.collecting) {
      calibration.fail('Microphone disconnected during calibration.');
    }
  },
  cancelContentValidationAndReport: () => {
    if (cancelActiveContentValidation()) broadcastJson(timingCalibrationStatusPayload());
  },
  reportStatus: () => broadcastStatus(),
});
const backingDisconnectCoordinator = createRelayBackingDisconnectCoordinator<RelaySocket>({
  isBacking: (socket) => backingRuntime.isSocket(socket),
  noteDisconnected: () => takeController.noteQualityEvent('backing-transport-disconnected'),
  clearRobotBackingBoundaryRequest: () => clearRobotBackingBoundaryRequest(),
  detach: (socket) => backingRuntime.detach(socket),
  clearBackingExpectation: () => session.setBackingExpected(false),
  failCalibrationIfCollecting: () => {
    if (calibration.collecting) {
      calibration.fail('Desktop Source disconnected during calibration.');
    }
  },
  cancelContentValidationAndReport: () => {
    if (cancelActiveContentValidation()) broadcastJson(timingCalibrationStatusPayload());
  },
  reportSourceStatus: () => broadcastJson(sourceStatusPayload()),
  reportStatus: () => broadcastStatus(),
});
const playbackDisconnectCoordinator = createRelayPlaybackDisconnectCoordinator<RelaySocket>({
  identity: (socket) => playbackTransport.identity(socket),
  now: () => performance.now(),
  pendingCommand: (identity, nowMs) => roomSongCommands.pendingForTarget(identity, nowMs),
  failPending: (identity, commandId) => roomSongCommands.fail(identity, commandId),
  reportCommandFailure: (commandId, nowMs) => {
    broadcastRoomSongCommandFailure(commandId, 'playback-disconnected', nowMs);
    broadcastJson(roomSongCommandStatusPayload(nowMs));
  },
  detachTimeline: (identity) => youtubeTimeline.detach(identity),
  reportTimelineChanged: () => {
    broadcastJson(youtubeTimeline.statusPayload());
    broadcastJson(youtubeTimeline.roomStatusPayload());
  },
});

let shuttingDown = false;

wss.on('connection', (rawSocket, request) => {
  const socket = rawSocket as RelaySocket;
  if (shuttingDown) {
    socket.close(1012, 'Relay is shutting down.');
    return;
  }
  const identity = participantIdentityFromUpgradeRequest(request);
  if (identity.kind === 'invalid') {
    sendJson(socket, {
      type: 'participant-auth-rejected',
      message: 'Participant identity did not match its private browser capability. Reload Relay.',
    });
    socket.close(1008, 'Participant capability mismatch.');
    return;
  }
  if (identity.kind === 'valid') attachParticipantIdentity(socket, identity);

  socket.on('message', (data, isBinary) => {
    if (shuttingDown) return;
    if (isBinary) {
      audioUplinkCoordinator.handle(socket, data as Buffer);
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(data.toString());
    } catch {
      sendJson(socket, { type: 'error', message: 'Invalid JSON message.' });
      return;
    }

    if (!message || typeof message !== 'object') return;
    const payload = message as Record<string, unknown>;
    if (queryProtocol.dispatch(socket, payload)) return;
    if (commandProtocol.dispatch(socket, payload)) return;
    if (infrastructureEventProtocol.dispatch(socket, payload)) return;
    if (authenticationProtocol.dispatch(socket, payload)) return;
    if (registrationProtocol.dispatch(socket, payload)) return;
    if (robotLifecycleProtocol.dispatch(socket, payload)) return;






  });

  socket.on('close', () => {
    playbackDisconnectCoordinator.handle(socket);
    let micTransportChanged = false;

    if (!socket.replaced) {
      robotDisconnectCoordinator.handle(socket);
      micTransportChanged = micDisconnectCoordinator.handle(socket);

      backingDisconnectCoordinator.handle(socket);
    }

    const presenceChanged = socket.participantConnectionId
      ? participants.detach(socket.participantConnectionId, Date.now())
      : false;
    if (presenceChanged || micTransportChanged) broadcastSessionStatus();
  });
});

wss.on('close', () => {
  micTransportGrace.cancel();
  clearMicMediaAuthority();
  clearInterval(mixerTimer);
  clearInterval(youtubeTimelineTimer);
});

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Stop the other Relay instance or set PORT.`);
    process.exit(1);
  }
  console.error('Relay server error', error);
  process.exit(1);
});

const directMediaConfig = webTransportMediaConfig();
if (directMediaConfig) {
  try {
    await webTransportMedia.start(directMediaConfig, {
      authorize(ticket) {
        return micRuntime.authorizeDirectMedia(ticket);
      },
      onDatagram(ticket, packet, nowMs) {
        deliverMicPackets(micRuntime.receiveDirectMedia(ticket, packet, nowMs));
      },
    });
    if (webTransportMedia.available) {
      console.log(
        `Relay WebTransport media listening on udp://${directMediaConfig.bindHost}:${directMediaConfig.bindPort}`
        + ` and advertised as ${directMediaConfig.publicUrl.toString()}`,
      );
    }
  } catch (error) {
    console.error('Failed to start Relay WebTransport media endpoint', error);
    process.exit(1);
  }
}

server.listen(port, '0.0.0.0', () => {
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  console.log(`Relay listening on http://localhost:${actualPort}`);
  console.log('For a phone, expose this HTTP server through an HTTPS tunnel before using the microphone.');
});

let shutdownPromise: Promise<void> | null = null;

async function gracefulShutdown(signal: NodeJS.Signals) {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  shutdownPromise = (async () => {
    console.log(`Relay received ${signal}; finalizing active work before shutdown.`);

    // Freeze the sample frontier first. Any Take finalized below is therefore
    // closed at the last full mixed frame that production actually accepted.
    clearInterval(mixerTimer);
    clearInterval(youtubeTimelineTimer);
    micTransportGrace.cancel();
    backingRuntime.cancelGrace();

    await takeController.shutdown(Date.now());
    await webTransportMedia.stop();

    for (const client of wss.clients) client.terminate();
    // relay-socket-server owns its heartbeat and retires it when WSS closes.
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  })().catch((error) => {
    console.error('Relay graceful shutdown failed', error);
    process.exitCode = 1;
  });
  return shutdownPromise;
}

return { gracefulShutdown } as const;
}
