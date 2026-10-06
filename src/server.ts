import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import WebSocket from 'ws';

import type { loadRelayConfig } from './config.js';
import { AudioSession } from './audio-session.js';
import { BackingRuntime } from './backing-runtime.js';
import { SourceRuntime } from './source-runtime.js';
import { loadAudioTransportConfig } from './audio-transport-config.js';
import { parseAudioUplinkHealth, type AudioUplinkHealth } from './audio-uplink-health.js';
import { parseMicPresenceTelemetry } from './mic-presence-telemetry.js';
import { micPresenceDisplayValues } from '../shared/mic-presence-precision.js';
import { monitorBacklogBudgetBytes } from './monitor-backpressure.js';
import { BootProbeRuntime } from './boot-probe-runtime.js';
import type { CalibrationApplicability } from './calibration-applicability.js';
import { PROBE_REFERENCE_MS } from './calibration-probe.js';
import {
  CalibrationSession,
  MAX_CAPTURE_GAP_MS,
  type CalibrationContext,
} from './calibration-session.js';
import { ContentCalibrationValidator } from './content-calibration-validator.js';
import { analyzeTimingCalibrationInWorker } from './timing-calibration-worker-client.js';
import { applyMicOwnerTransitionEffects } from './mic-owner-transition-application.js';
import { MicAudibilityMonitor, type MicAudibilityResult } from './mic-audibility-monitor.js';
import { MicLevelMonitor } from './mic-level-monitor.js';
import { MicGainMemory } from './mic-gain-memory.js';
import { MicClockDriftEstimator } from './mic-clock-drift-estimator.js';
import { MicCaptureDeliveryMonitor } from './mic-capture-delivery.js';
import { youtubeErrorMeansUnplayable } from '../shared/robot-player-errors.js';
import { MicRuntime } from './mic-runtime.js';
import { MicTransportGraceRuntime } from './mic-transport-grace-runtime.js';
import { TimingRuntime } from './timing-runtime.js';
import { authorizeMicOwnerCommand, type MicOwnerCommand } from './command-authority.js';
import { decodePcmFrame, type PcmFrame } from './pcm-frame.js';
import type { ProbeTarget } from './probe-lifecycle.js';
import {
  projectObservationStatusV1,
  projectProductStatus,
  projectRemoteStatus,
  type RobotPlayerError,
} from './relay-status-projection.js';
import { createRelayStatusFacts } from './relay-status-facts.js';
import { createRelayMixPump } from './relay-mix-pump.js';
import { createRelayHttpServer } from './relay-http-server.js';
import { createRelayQueryProtocol } from './relay-query-protocol.js';
import { loadMonitorOpusEncoder } from './monitor-opus.js';
import { createRelayCommandProtocol } from './relay-command-protocol.js';
import { createRelayInfrastructureEventProtocol } from './relay-infrastructure-event-protocol.js';
import { createRelayAuthenticationProtocol } from './relay-authentication-protocol.js';
import { createRelayRegistrationProtocol } from './relay-registration-protocol.js';
import { createRelayMicLifecycle } from './relay-mic-lifecycle.js';
import { createRelayBackingLifecycle } from './relay-backing-lifecycle.js';
import { createRelayRobotLifecycleProtocol } from './relay-robot-lifecycle-protocol.js';
import { createRelayBootProbeOrchestration } from './relay-boot-probe-orchestration.js';
import { createRelayCalibrationOrchestration, createRelayContentCalibrationOrchestration, createRelayCalibrationLifecycle } from './relay-calibration-orchestration.js';
import { createRelayAudioUplinkCoordinator } from './relay-audio-uplink-coordinator.js';
import { createRelayRobotMappingOrchestration } from './relay-robot-mapping-orchestration.js';
import { createRelayTakeCommandCoordinator } from './relay-take-command-coordinator.js';
import { createRelaySongCommandOrchestration, createRelaySongLifecycle } from './relay-song-orchestration.js';
import {
  createMonitorSocketTransport,
  createRelaySocketTransport,
  createRelayWebSocketServer,
  parseBroadcastTypes,
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
import { InfrastructureCapabilityRuntime } from './infrastructure-capability-runtime.js';
import { parseRoomSongCommand } from './room-song-command.js';
import { RoomSongCommandRuntime } from './room-song-command-runtime.js';
import {
  LEGACY_PLAYBACK_PARTICIPANT_ID,
  LEGACY_PLAYBACK_TRANSPORT_ID,
  SongSession,
  normalizePlaybackGeneration,
  normalizePlaybackTransportId,
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
/**
 * Room audio a Listen page may have outstanding - sent but not confirmed - on
 * top of its round trip, before it is dropped to rejoin the live edge. The
 * byte backlog above only sees this process's own socket buffer.
 */
const MONITOR_UNACKNOWLEDGED_SAMPLES = Math.round(
  (MIX_SAMPLE_RATE * relayConfig.monitorUnacknowledgedMs) / 1_000,
);
/** The same time budget for an Opus listener, at the Opus bitrate. */
const MONITOR_OPUS_BACKLOG_BYTES = Math.max(
  1,
  Math.round((relayConfig.listenOpusBitrate / 8) * (MONITOR_BACKLOG_MS / 1_000)),
);
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
const FIXED_SONG_LEVEL = 100;
const HEARTBEAT_MS = relayConfig.heartbeatMs;
const MIX_HEALTH_INTERVAL_MS = 1_000;
/**
 * How often the room timeline goes out while a Song has telemetry. The
 * leader's page samples its player every 250 ms and each accepted packet
 * already broadcasts a fresh snapshot, so the timer only fills in when that
 * stops. Sending its own copy as well doubled the most frequent status on
 * every socket - about 60 kbps per page - and told nobody anything new.
 */
const TIMELINE_STATUS_REFRESH_MS = 250;
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
  statusDeflate: relayConfig.statusDeflate,
});
const {
  sendJson,
  broadcastJson,
  subscribeBroadcasts,
  retire: retireSocket,
  canClaimSocketRole,
  commitSocketRole,
} = createRelaySocketTransport(wss);
const monitorTransport = createMonitorSocketTransport(wss, {
  backlogBytes: MONITOR_BACKLOG_BYTES,
  unacknowledgedSamples: MONITOR_UNACKNOWLEDGED_SAMPLES,
  opusBacklogBytes: MONITOR_OPUS_BACKLOG_BYTES,
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

const relaySongCommands = createRelaySongCommandOrchestration<RelaySocket>({
  clock: { now: () => performance.now() },
  commands: roomSongCommands,
  song: youtubeTimeline,
  playback: playbackTransport,
  participants,
  queries: { participantPayload, commandStatusPayload: roomSongCommandStatusPayload },
  effects: { send: sendJson, broadcast: broadcastJson },
});

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
let lastTelemetryTimelineBroadcastAtMs = Number.NEGATIVE_INFINITY;

const relaySongLifecycle = createRelaySongLifecycle<RelaySocket>({
  clock: { now: () => performance.now() },
  participants,
  song: youtubeTimeline,
  playback: playbackTransport,
  commands: roomSongCommands,
  commandOrchestration: relaySongCommands,
  queries: { commandStatusPayload: roomSongCommandStatusPayload },
  crossCommands: { cancelActiveContentValidation, revokeContentMappingOnRateChange },
  effects: {
    send: sendJson,
    broadcast: broadcastJson,
    reportTimingStatus: () => broadcastJson(timingCalibrationStatusPayload()),
    reportAcceptedTimelineStatus: (status) => {
      lastTelemetryTimelineBroadcastAtMs = performance.now();
      broadcastJson(status);
    },
  },
});

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

/**
 * Diagnostics for the "Mic shows live but the room hears no voice" class. It
 * logs and feeds /statusz only; see MicAudibilityMonitor for why micPlayable
 * cannot see these shapes.
 */
const micAudibility = new MicAudibilityMonitor({ sampleRate: MIX_SAMPLE_RATE });
const micLevel = new MicLevelMonitor({ sampleRate: MIX_SAMPLE_RATE });
/** Each participant's last Mic gain, so a handoff does not inherit the previous singer's. */
const micGains = new MicGainMemory({ defaultGainDb: session.micGainDb });
/** Diagnostic only: how far the phone capture clock drifts from the mix clock. */
const micClockDrift = new MicClockDriftEstimator();
/**
 * How much real time the phone's own Mic capture has lost. Confirmed loss is
 * what lets AudioSession fold a growing frontier correction into the timeline.
 */
const micCaptureDelivery = new MicCaptureDeliveryMonitor();
let micCaptureFallingBehind = false;
let reportedMicTimelineFolds = 0;
let micAudibilityReceiverBaseline: { [key: string]: number } | null = null;

// Read here rather than beside the other calibration constants because the
// Take quality policy needs it too: it is the line between the mixer's own
// hysteresis and a correction a recording actually blocked.
const BOOT_DELTA_REAPPLY_MS = relayConfig.calibrationDeltaReapplyMs;

const takeController = new TakeController({
  directory: takeDir,
  sampleRate: MIX_SAMPLE_RATE,
  timingDivergenceToleranceMs: BOOT_DELTA_REAPPLY_MS,
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
const ROBOT_OFFSET_FRESH_MS = 2_000;
const ROBOT_OFFSET_WINDOW_MS = relayConfig.robotOffsetWindowMs;
// robot-player-offset is a residual tracking measurement, not an arbitrary
// media-position gap. Source seeks at 450 ms; keep a generous server-side
// sanity fence so a bootstrap gap can never become timing authority.
const ROBOT_PLAYER_OFFSET_MAX_ABS_MS = 5_000;
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
  maxEvidenceGapMs: MAX_CAPTURE_GAP_MS,
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
    readBackingEvidence: (start, length) => session.readBackingEvidence(start, length),
    readMicEvidence: (start, length) => session.readMicEvidence(start, length),
    transitionEvidence: (maxSamples) => calibration.transitionEvidence(maxSamples),
    commit: (plan, nowMs) => relayRobotMapping.commit(plan, nowMs),
    onDegraded: (status) => {
      console.warn(
        '[robot-content-transition] degraded fail-closed:'
        + ` reason=${status.degradedReason ?? 'unknown'}`
        + ` windows=${status.windowsStarted}/${status.maxWindows}`
        + ` workerFailures=${status.workerFailures}/${status.maxWorkerFailures}`
        + ` ageMs=${status.ageMs}`,
      );
      // A verifying transition may temporarily pause an existing content
      // collection while its backing PCM is quarantined. Once the verifier
      // degrades, however, there is no commit that can ever release that PCM.
      // Tear down both halves of that failed transaction: leaving the runtime
      // degraded *or* the mapper awaiting a boundary would keep content
      // evidence quarantined forever. A fresh Robot delta can then establish a
      // new bootstrap mapping, while the source-generation bump makes the old
      // reference-frame calibration fail closed.
      revokeRobotContentMapping({
        reason: 'Robot backing content mapping could not be verified.'
          + ' Rebuilding the Robot content mapping before calibration retries.',
      });
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
  sendDirectMedia: (ticket, bytes) => webTransportMedia.sendDatagram(ticket, bytes),
});

const micTransportGrace = new MicTransportGraceRuntime({
  graceMs: MIC_TRANSPORT_GRACE_MS,
  onExpired: expireMicTransportGrace,
});

function micStreaming(nowMs = performance.now()) {
  return micRuntime.streaming(nowMs);
}

function backingStreaming(nowMs = performance.now()) {
  return backingRuntime.streaming(nowMs, STREAM_LIVE_MS);
}

/**
 * Packet freshness answers whether transport is moving. Product/calibration
 * freshness additionally requires the live mixer frontier to have caught up:
 * stale queued PCM can arrive continuously while the emitted frame is silence.
 */
function micPlayable(nowMs = performance.now()) {
  return micStreaming(nowMs) && session.micPlayable;
}

function backingPlayable(nowMs = performance.now()) {
  return backingStreaming(nowMs) && session.backingPlayable;
}

function bothStreamsFlowing(nowMs: number) {
  return silentSides(nowMs).length === 0;
}

function silentSides(nowMs: number) {
  const silent: string[] = [];
  if (!micPlayable(nowMs)) silent.push('microphone');
  if (!backingPlayable(nowMs)) silent.push('desktop capture');
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
  relayMicLifecycle.clearMediaAuthority();
}

function expireMicTransportGrace(expectedOwnerId: string) {
  relayMicLifecycle.expire(expectedOwnerId);
}

function calibrationContext(): CalibrationContext {
  return relayCalibration.context();
}

/**
 * Whether this room's backing and Source are the Robot pair.
 *
 * A physical fact about the topology, and deliberately nothing else. Turning
 * off a *strategy* cannot make a Robot stop being a Robot: content authority,
 * mapping readiness and Robot Take quality semantics all describe the route
 * that exists, not the measurement anyone happens to prefer. Reading a
 * strategy flag for those made `RELAY_CALIBRATION_PROBE=0` silently retire the
 * Robot content mapping and report `robotRoute: false` for a room plainly on
 * one - see ARCHITECTURE_BOUNDARIES.md section 7.
 */
function robotRouteActive() {
  return relayRobotMapping.routeActive();
}

/**
 * Whether the boot probe is the strategy a *new* measurement would use here.
 *
 * Route AND configuration: the audible probe is opt-out, so this is the only
 * question `RELAY_CALIBRATION_PROBE` is allowed to answer.
 */
function robotProbeTimingActive() {
  return PROBE_CALIBRATE && robotRouteActive();
}

/** The current Robot route has spent its bounded probe attempts. */
function probeCalibrationExhausted(nowMs = performance.now()) {
  return robotProbeTimingActive() && probeStatus(nowMs).error !== null;
}

/**
 * Whether the bounded boot probe has stopped being the preferred strategy.
 *
 * Boot probe is a fast baseline, not the terminal strategy, so the question
 * every content gate needs to ask is "has boot finished?", not "has boot
 * failed?". It finishes either way: by producing a usable path baseline for the
 * current capture context, or by spending its bounded attempts. Only *before*
 * that must content calibration wait its turn.
 *
 * Asking the failure question instead is what left content permanently
 * un-appliable and drift validation permanently unarmed on a successful boot:
 * a probe that succeeds never reports an error, so a gate keyed on error stays
 * shut forever.
 */
function bootProbeSettled(nowMs = performance.now()): boolean {
  if (!robotProbeTimingActive()) return true;
  if (probeCalibrationExhausted(nowMs)) return true;
  return bootProbeRuntime.pathDifferenceMs !== null
    && bootProbeRuntime.completedContextMatches(bootProbeContext());
}

function robotContentFallbackPrimingActive(nowMs = performance.now()) {
  if (
    !AUTO_CALIBRATE
    || takeBlocksCalibration()
    || !robotProbeTimingActive()
    || bootProbeSettled(nowMs)
    || !robotContentEvidenceMappingReady(nowMs)
  ) return false;
  const timeline = currentTimelineStatus(nowMs);
  return Boolean(timeline.connected) && Number(timeline.state) === 1;
}

function robotDeltaIsFresh(nowMs = performance.now()) {
  return relayRobotMapping.deltaFresh(nowMs);
}

/**
 * Whether the Robot has reported a player offset at all in the current mapping.
 *
 * The discriminator between a heartbeat that has gone quiet and one that never
 * started. Every path that genuinely invalidates the mapping resets the
 * tracker, so "something was reported since the last reset" is exactly "the
 * applied total already carries a player-relative term measured in this
 * mapping".
 */
/**
 * The room's playback rate, as the mixer must read it.
 *
 * The single source for every media-to-wall conversion in the timing domain.
 * A room with no Song, or one whose Source has not reported yet, is 1x by
 * definition: there is no media clock running at any other speed.
 */
function currentPlaybackRate(nowMs = performance.now()) {
  const rate = Number(currentTimelineStatus(nowMs).playbackRate);
  return Number.isFinite(rate) && rate > 0 ? rate : 1;
}

function robotDeltaEverEstablished() {
  return Number.isFinite(robotPlayerOffset.lastReportedAtMs);
}

function robotContentMappingReady(nowMs = performance.now()) {
  return relayRobotMapping.contentMappingReady(nowMs);
}

// A fresh timeline can still be intentionally withholding backing PCM while a
// follower correction waits for its capture/content boundary. That mapping is
// safe for the already-applied live authority (which keeps using committed
// content), but it is not usable as new correlation evidence: mapBackingStart()
// will return null until the boundary is committed.
function robotContentEvidenceMappingReady(nowMs = performance.now()) {
  return relayRobotMapping.contentEvidenceReady(nowMs);
}

function mappedContentBackingStart(startSample: number, nowMs = performance.now()) {
  return relayRobotMapping.mapBackingStart(startSample, nowMs);
}

/**
 * Whether a concrete Robot follower seek may preserve the existing content
 * mapping rather than becoming a destructive bootstrap remap.
 *
 * Confirmed content authority is sufficient even while a prior correction is
 * still waiting for its PCM boundary: repeated finite corrections intentionally
 * carry that proven pre-seek reference forward. Before first promotion, an
 * in-flight content collection may also preserve a small correction when it
 * already owns enough common pre-seek PCM to launch the anchor worker
 * immediately. With neither source of evidence, preservation would recreate
 * the windows=0 catch-22, so the seek must reset mapping instead.
 */
function robotFollowerSeekMayPreserveMapping(nowMs = performance.now()) {
  return relayRobotMapping.followerSeekMayPreserveMapping(nowMs);
}

/**
 * Retires the whole Robot content-transition transaction.
 *
 * This is intentionally stronger than `clearPendingBoundary()`: lifecycle
 * discontinuities must abort any anchor/compare worker and discard quarantined
 * transition state, not merely forget an outstanding sample-boundary request.
 */
function clearRobotContentTransition() {
  relayRobotMapping.clearTransition();
}

/**
 * The single way to revoke Robot content mapping.
 *
 * This used to be an open-coded checklist repeated at every event that could
 * invalidate the mapping, and no two copies cleared the same subset - which is
 * why fixing one path kept leaving the others holding state that had just been
 * proven wrong. `reason` is what an in-flight calibration reports when it
 * cannot survive the revocation; anything else that later needs to differ per
 * caller belongs in an option here, not in which lines somebody remembered to
 * write at the call site.
 */
function revokeRobotContentMapping({ reason }: { reason: string }) {
  relayRobotMapping.revoke(reason);
}

/**
 * Retires a Robot content mapping the room's playback rate has invalidated.
 *
 * The mapper folds media-time player deltas into a wall-time reference frame,
 * so the rate is part of the mapping, not a parameter of reading it. Every
 * delta already folded in was converted at the old rate; nothing can be
 * rescaled in place. That makes a rate change the same class of event as a
 * destructive seek, and it takes the same single revocation transaction.
 *
 * Boot-probe authority deliberately survives: a measured pipeline latency is
 * wall time and says nothing about how fast the song is playing.
 * `maybeReapplyBootCalibration()` folds the delta back in at the new rate.
 */
function revokeContentMappingOnRateChange(playbackRate: unknown) {
  return relayRobotMapping.revokeOnRateChange(playbackRate);
}

function robotContentTransitionStatus(nowMs = performance.now()) {
  return robotContentTransitionRuntime.status(nowMs);
}

function sweepRobotContentTransition(nowMs: number) {
  return robotContentTransitionRuntime.sweep(nowMs);
}

function feedContentBackingEvidence(samples: Int16Array, start: number, nowMs: number) {
  if (samples.length === 0) return;
  if (robotContentFallbackPrimingActive(nowMs)) {
    calibration.primeBacking(samples, start);
  }
  calibration.observeBacking(samples, start);
  contentCalibrationValidator.observeBacking(samples, start);
}

function noteRobotTransitionBackingFrame(
  frame: PcmFrame,
  samples: Int16Array,
  start: number,
  nowMs: number,
) {
  relayRobotMapping.noteBackingFrame(frame, samples, start, nowMs);
}

function requestRobotBackingBoundary(nowMs = performance.now()) {
  return relayRobotMapping.requestBoundary(nowMs);
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
    timingRuntime.syncConfirmedAuthority({
      confirmedRevision: calibration.confirmedRevision,
      hasConfirmedResult: calibration.confirmedResult !== null,
    });
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

// All domain owners are constructed before this inert assembly is bound.
// The hoisted wrappers above defer queries until normal server operation.
const relayRobotMapping = createRelayRobotMappingOrchestration({
  socketOpenState: WebSocket.OPEN,
  mixSampleRate: MIX_SAMPLE_RATE,
  transitionHistorySamples: ROBOT_CONTENT_TRANSITION_HISTORY_SAMPLES,
  maxCaptureGapMs: MAX_CAPTURE_GAP_MS,
  backing: backingRuntime,
  source: sourceRuntime,
  offset: robotPlayerOffset,
  timeline: robotContentTimeline,
  calibration,
  validator: contentCalibrationValidator,
  timing: timingRuntime,
  transition: robotContentTransitionRuntime,
  mix: session,
  take: takeController,
  commands: { abandonProbeRun },
  queries: {
    context: calibrationContext,
    appliedKind: appliedCalibrationKind,
    calibrationIsStale,
    currentPlaybackRate,
    bootProbeSettled,
  },
  effects: {
    notifyPreviousReplaced: (previous) => sendJson(previous, { type: 'robot-source-replaced' }),
    feedBackingEvidence: feedContentBackingEvidence,
    clearContentValidation: clearContentValidationBaseline,
    syncAppliedCalibration: () => { syncAppliedCalibration(); },
    reportSourceStatus: () => broadcastJson(sourceStatusPayload()),
    reportTimingStatus: () => broadcastJson(timingCalibrationStatusPayload()),
    sendBoundaryRequest: (target, message) => sendJson(target, message),
  },
});

// Inert binding: constructors above retain callbacks without invoking them.
// Live queries continue to sample the canonical owners at their original call sites.
const relayCalibration = createRelayCalibrationOrchestration({
  config: { reapplyThresholdMs: BOOT_DELTA_REAPPLY_MS },
  clock: performance,
  mix: session,
  mic: micRuntime,
  backing: backingRuntime,
  source: sourceRuntime,
  calibration,
  timing: timingRuntime,
  probe: bootProbeRuntime,
  contentTimeline: robotContentTimeline,
  queries: {
    takeBlocksCalibration,
    robotRouteActive,
    robotProbeTimingActive,
    bootProbeSettled,
    bootProbeContext,
    roomHasSong,
    robotDeltaIsFresh,
    robotDeltaEverEstablished,
    robotContentMappingReady,
    currentDeltaMs,
    currentPlaybackRate,
  },
});

const relayContentCalibration = createRelayContentCalibrationOrchestration({
  config: { autoEnabled: AUTO_CALIBRATE, validationEnabled: CONTENT_VALIDATION_ENABLED },
  clock: performance,
  mix: session,
  calibration,
  timing: timingRuntime,
  validator: contentCalibrationValidator,
  backing: backingRuntime,
  mic: micRuntime,
  queries: {
    calibrationContext,
    appliedCalibrationKind,
    calibrationIsStale,
    takeBlocksCalibration,
    robotRouteActive,
    bootProbeSettled,
    robotContentEvidenceMappingReady,
    bothStreamsFlowing,
    currentTimelineStatus,
    probeCalibrationExhausted,
  },
  effects: { reportTimingStatus: () => broadcastJson(timingCalibrationStatusPayload()) },
});

const relayCalibrationLifecycle = createRelayCalibrationLifecycle({
  mix: session,
  calibration,
  timing: timingRuntime,
  probe: bootProbeRuntime,
  backing: backingRuntime,
  offset: robotPlayerOffset,
  contentTimeline: robotContentTimeline,
  commands: {
    clearContentValidation: clearContentValidationBaseline,
    syncAppliedCalibration,
    clearRobotContentTransition,
    abandonProbeRun,
    maybeStartProbeCalibration,
  },
  effects: {
    endTakeMix: () => takeController.endMix(),
    reportTimingStatus: () => broadcastJson(timingCalibrationStatusPayload()),
    reportSourceStatus: () => broadcastJson(sourceStatusPayload()),
    reportStatus: () => broadcastStatus(),
    resetMicAudibility,
    resetMicLevel: () => micLevel.reset(),
  },
});

const relayMicLifecycle = createRelayMicLifecycle<RelaySocket>({
  clock: { now: () => performance.now() },
  participants,
  mic: micRuntime,
  mix: session,
  grace: micTransportGrace,
  backing: backingRuntime,
  calibration,
  take: takeController,
  queries: { participantPayload },
  commands: {
    applyOwnershipEffects: applyMicOwnerEffects,
    invalidateTiming: invalidateMicTiming,
    clearRobotContentTransition,
    refreshLiveMicNetworkCompensation,
    cancelActiveContentValidation,
    stopLiveSource,
    beginPreparedSongHandoff,
    abandonProbeRun,
    clearContentValidationBaseline,
    syncAppliedCalibration,
  },
  effects: {
    resetMicAudibility,
    resetMicLevel: () => micLevel.reset(),
    retirePublisher: (socket, payload) => retireSocket(socket, payload),
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
    sendReleased: (socket) => sendJson(socket, { type: 'mic-released' }),
    reportStatus: () => broadcastStatus(),
    reportSessionStatus: () => broadcastSessionStatus(),
    reportTimingStatus: () => broadcastJson(timingCalibrationStatusPayload()),
    reportSourceStatus: () => broadcastJson(sourceStatusPayload()),
  },
});

function clearContentValidationBaseline() {
  relayContentCalibration.clearBaseline();
}


function cancelActiveContentValidation(nowMs = performance.now()) {
  return relayContentCalibration.cancelValidation(nowMs);
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

function rejectRoomSongCommand(socket: RelaySocket, commandId: unknown, reason: string) {
  relaySongCommands.reject(socket, commandId, reason);
}

function cancelPendingRoomSongCommand(reason: string, nowMs = performance.now()) {
  return relaySongCommands.cancelPending(reason, nowMs);
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
  return relaySongLifecycle.stepHandoff(nowMs);
}

function beginPreparedSongHandoff(participantId: string, nowMs = performance.now()) {
  return relaySongLifecycle.prepare(participantId, nowMs);
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
    restoreMicGain: (participantId) => restoreMicGainFor(participantId),
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
  relaySongCommands.reportRoomTelemetryRejected(socket, reason);
}

function reportTelemetryRejected(socket: RelaySocket, reason: string) {
  relaySongCommands.reportTelemetryRejected(socket, reason);
}

function replacePrevious(previous: RelaySocket | null, next: RelaySocket, message: string) {
  if (!previous || previous === next) return;
  retireSocket(previous, { type: 'error', message });
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
  return relayCalibration.isStale();
}

/**
 * Strategy that owns the value currently exposed by `CalibrationSession.result`.
 *
 * Candidate/orchestration kind may switch as soon as a retry starts. Confirmed
 * authority kind may switch only with a new confirmed revision. A provisional
 * result is the one exception: by definition it belongs to the in-flight
 * candidate that produced it.
 */
function appliedCalibrationKind() {
  return relayCalibration.appliedKind();
}

/**
 * Whether a measurement may drive the mixer, and what to do when it may not.
 *
 * `revoke` means the measurement itself is void. `hold` means it is still a
 * valid measurement of an unchanged acoustic path, but a *live* input needed
 * to complete it has momentarily gone quiet - which is not the same thing and
 * must not be treated as one. Falling back to the network estimate there
 * replaces a measured alignment with a guess, and the room hears the whole
 * difference as a step in the middle of a song. The Robot reports its player
 * offset a few times a second and goes quiet for ordinary reasons: buffering,
 * the settle window after a seek, a track change. Its position does not
 * teleport while it is quiet, so the last applied total stays the best answer
 * available until either a fresh offset arrives or something actually
 * invalidates the mapping - a disconnect, a capture epoch, a gross jump - each
 * of which revokes through its own path.
 */
function calibrationApplicability(kind = appliedCalibrationKind()): CalibrationApplicability {
  return relayCalibration.applicability(kind);
}

/**
 * The boot baseline's live total: measured pipeline path, plus where the
 * player currently is.
 *
 * One expression with two readers - the applier in
 * `maybeReapplyBootCalibration()` and the observer in
 * `desiredCalibratedMicLagMs()`. They must never be able to disagree about
 * what the boot strategy currently wants.
 */
function bootProbeAdvanceMs(nowMs: number) {
  return relayCalibration.bootAdvance(nowMs);
}

/**
 * What the mixer's Mic advance would be if it were free to follow the mapping.
 *
 * `syncAppliedCalibration()` deliberately freezes the applied alignment for the
 * whole of a Take, because moving the read head mid-recording splices the voice
 * audibly. What is *not* frozen is the mapping underneath it: the Robot player
 * delta keeps drifting, and a preserving follower correction commits a new
 * content mapping without ever invalidating the measurement - so neither
 * `calibrationStale` nor any transport event fires. The recording is then
 * aligned to a mapping that is no longer the room's, and every existing quality
 * signal still reads clean.
 *
 * This computes the value the appliers would install, without installing it, so
 * a Take can record how far it drifted from the alignment it was handed.
 * `null` means there is no current answer to diverge from - which the
 * timing-fallback, calibration-stale and robot-delta-missing signals already
 * describe.
 */
function desiredCalibratedMicLagMs(nowMs: number): number | null {
  return relayCalibration.desiredLag(nowMs);
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
 * Candidate strategy is intentionally not consulted here. A replacement retry
 * cannot reinterpret the old confirmed result under its own strategy before
 * promotion.
 *
 * Returns whether the mixer alignment changed so the periodic freshness check
 * can publish the transition immediately.
 */
function syncAppliedCalibration() {
  return relayCalibration.syncApplied();
}

function sourceStatusPayload() {
  const alignment = session.alignment;
  const calibrationStatus = calibration.status();
  const nowMs = performance.now();
  const micUplink = micRuntime.freshUplinkHealthPayload(nowMs);
  return {
    type: 'source-status',
    observedAtMs: nowMs,
    sessionGeneration: session.generation,
    connected: backingRuntime.connected(),
    micConnected: micMediaConnected(),
    micMediaPath: micMediaPath(),
    micCaptureDispatch: micUplink?.captureDispatch ?? null,
    micCaptureBacklogSamples: micUplink?.droppedSamples.captureBacklog ?? 0,
    backingStreaming: backingStreaming(nowMs),
    backingPlayable: backingPlayable(nowMs),
    micStreaming: micStreaming(nowMs),
    micPlayable: micPlayable(nowMs),
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
    activeCalibrationKind: appliedCalibrationKind(),
    robotRoute: robotRouteActive(),
    robotSourceConnected: sourceRuntime.connected(),
    robotDeltaFresh: robotDeltaIsFresh(nowMs),
    robotFollowerSeekPreservesMapping: robotFollowerSeekMayPreserveMapping(nowMs),
    vocalFineTuneMs: alignment.fineTuneMs,
    appliedMicAdvanceMs: session.appliedMicAdvanceMs,
    requestedMicAdvanceMs: session.requestedMicAdvanceMs,
    micFrontierCorrectionMs: session.micFrontierCorrectionMs,
  };
}

function takeQualityFrameState(nowMs = performance.now()) {
  const alignment = session.alignment;
  const desiredMicLagMs = desiredCalibratedMicLagMs(nowMs);
  return {
    timingMode: alignment.calibratedMicLagMs === null
      ? 'network-estimate' as const
      : 'acoustic-calibration' as const,
    calibrationStale: calibrationIsStale(),
    alignmentClamped: Math.abs(session.requestedMicAdvanceMs - session.appliedMicAdvanceMs) >= 0.5,
    robotRoute: robotRouteActive(),
    robotDeltaFresh: robotDeltaIsFresh(nowMs),
    // How far the frozen recording alignment has drifted from the mapping the
    // room is actually on. Null while there is no applicable answer to compare
    // against; the other timing signals own that case.
    timingDivergenceMs: desiredMicLagMs === null || alignment.calibratedMicLagMs === null
      ? null
      : desiredMicLagMs - alignment.calibratedMicLagMs,
  };
}

function micUplinkHealthPayload(nowMs = performance.now()) {
  return micRuntime.uplinkHealthPayload(nowMs);
}

function mixHealthPayload() {
  const health = session.health();
  const monitorDrops = monitorTransport.recentDrops();
  return {
    type: 'mix-health',
    active: session.active,
    ...health,
    micGainDb: session.micGainDb,
    monitorDroppedFrames: monitorTransport.droppedFrames,
    monitorRecentDroppedFrames: monitorDrops.frames,
    monitorRecentDroppingListeners: monitorDrops.listeners,
    prebufferMs: session.prebufferMs,
    micMediaPath: micMediaPath(),
    micUplink: micUplinkHealthPayload(),
    micTransport: micRuntime.receiverStats(),
  };
}

const relayStatusFacts = createRelayStatusFacts({
  mixSampleRate: MIX_SAMPLE_RATE,
  mix: session,
  participants,
  monitor: monitorTransport,
  backing: backingRuntime,
  robot: {
    get playerError() { return robotPlayerError; },
    offset: robotPlayerOffset,
    routeActive: robotRouteActive,
    deltaFresh: robotDeltaIsFresh,
    probeTimingActive: robotProbeTimingActive,
    contentEvidenceReady: robotContentEvidenceMappingReady,
  },
  source: sourceRuntime,
  song: { runtime: youtubeTimeline, hasSong: roomHasSong },
  take: takeController,
  media: { backingPlayable, micPlayable },
  timing: {
    calibration,
    probe: bootProbeRuntime,
    applicability: calibrationApplicability,
    isStale: calibrationIsStale,
    appliedKind: appliedCalibrationKind,
    calibrationInProgress: timingCalibrationInProgress,
    bootProbeInProgress,
  },
  mic: {
    runtime: micRuntime,
    audibility: micAudibility,
    level: micLevel,
    drift: micClockDrift,
    captureDelivery: micCaptureDelivery,
  },
});

/** /statusz; see projectRemoteStatus for what it promises. */
function remoteStatusPayload() {
  return projectRemoteStatus(relayStatusFacts.remote(performance.now()));
}

function observationStatusV1Payload() {
  const remote = remoteStatusPayload();
  return projectObservationStatusV1(remote, {
    micLeaseHeld: participants.snapshot().micOwnerId !== null,
    micSampleRate: micRuntime.sampleRate,
  });
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
    observedAtMs: nowMs,
    sessionGeneration: session.generation,
    ...status,
    activeMicLagMs: alignment.calibratedMicLagMs,
    timingMode: alignment.calibratedMicLagMs === null ? 'network-estimate' : 'acoustic-calibration',
    calibrationStale: calibrationIsStale(),
    calibrationKind: timingRuntime.calibrationKind,
    activeCalibrationKind: appliedCalibrationKind(),
    robotRoute: robotRouteActive(),
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

/** Keep the entry's default clock; collection lives with the status boundary. */
function readinessPayload(nowMs = performance.now()) {
  return relayStatusFacts.readiness(nowMs);
}

function productStatusPayload(nowMs = performance.now()) {
  return projectProductStatus(relayStatusFacts.product(nowMs));
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

function invalidateMicTiming(message: string) {
  relayCalibrationLifecycle.invalidateMicTiming(message);
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

function abandonProbeRun() {
  relayBootProbe.abandon();
}





function stopLiveSource() {
  relayCalibrationLifecycle.stopLiveSource();
}

function roomHasSong(nowMs = performance.now()) {
  return takeSongSnapshot(nowMs).videoId !== null;
}

/** The song is audibly under the voice: YouTube says playing and its audio is arriving. */
/**
 * What the Robot's player last said about a video it could not play. Only the
 * Robot page sees a YouTube error; without this the room got no Song and no
 * reason, beyond a stale timing delta.
 */
let robotPlayerError: RobotPlayerError | null = null;

function noteRobotPlayerStatus(videoId: string | null, errorCode: number | null) {
  const next = videoId !== null && errorCode !== null ? { videoId, code: errorCode } : null;
  if (JSON.stringify(next) === JSON.stringify(robotPlayerError)) return;
  robotPlayerError = next;
  console.warn('[robot-player]', JSON.stringify({
    videoId,
    errorCode,
    unplayable: next !== null && youtubeErrorMeansUnplayable(next.code),
  }));
  broadcastProductStatus();
}

function roomSongPlaying(nowMs = performance.now()) {
  return takeSongSnapshot(nowMs).state === 1 && backingPlayable(nowMs);
}

const relayBackingLifecycle = createRelayBackingLifecycle<RelaySocket>({
  backing: backingRuntime,
  mix: session,
  calibration,
  take: takeController,
  commands: {
    clearRobotContentTransition,
    dropLegacyCalibrationForRobot,
    abandonProbeRun,
    clearContentValidationBaseline,
    cancelActiveContentValidation,
    syncAppliedCalibration,
    invalidateMicTiming,
    startLiveSource,
    stopLiveSource,
  },
  effects: {
    retirePrevious: replacePrevious,
    sendRegistered: (socket, robot) => {
      sendJson(socket, { type: 'registered', role: 'backing', robot });
    },
    reportTimingStatus: () => broadcastJson(timingCalibrationStatusPayload()),
    reportSourceStatus: () => broadcastJson(sourceStatusPayload()),
    reportStatus: () => broadcastStatus(),
  },
});

function expireBackingGrace() {
  const micArmed = micRuntime.controlConnected()
    || webTransportMicConnected()
    || micTransportGrace.pending;
  relayBackingLifecycle.expireGrace({
    roomHasSong: roomHasSong(),
    micArmed,
  });
}


const relayMixPump = createRelayMixPump({
  now: () => performance.now(),
  mix: session,
  mic: micRuntime,
  audibility: micAudibility,
  level: micLevel,
  drift: micClockDrift,
  calibration,
  validator: contentCalibrationValidator,
  transition: robotContentTransitionRuntime,
  restart: { restart: relayMicLifecycle.restartCapture },
  take: takeController,
  monitor: monitorTransport,
  effects: {
    startLiveSource,
    resetAudibility: resetMicAudibility,
    fallbackPrimingActive: robotContentFallbackPrimingActive,
    quality: takeQualityFrameState,
    micPlayable,
    roomSongPlaying,
    reportAudibility: reportMicAudibility,
    reportLevel: reportMicLevel,
    reportTimelineFolds: reportMicTimelineFolds,
  },
});
relayMixPump.start();

function reportMicLevel(reason: 'window' | 'gain') {
  console.warn('[mic-level]', JSON.stringify({ reason, ...micLevel.status() }));
}

/**
 * Measures the phone's capture against real time from its own sample count and
 * hands confirmed loss to the mixer (see MicCaptureDeliveryMonitor).
 */
function noteMicCaptureDelivery(health: AudioUplinkHealth, nowMs: number) {
  if (micRuntime.sampleRate === null) return;
  micCaptureDelivery.observe({
    generation: health.captureGeneration,
    capturedSamples: health.capturedSamples,
    sampleRate: micRuntime.sampleRate,
    atMs: nowMs,
  });
  const delivery = micCaptureDelivery.status();
  if (!delivery) return;
  session.noteMicCaptureLoss(delivery.generation, delivery.lossMs);
  // A phone falling behind real time is what grows the frontier correction,
  // and nothing else names it. Edge-logged, with a little hysteresis.
  const fallingBehind = delivery.ratio !== null
    && delivery.ratio < (micCaptureFallingBehind ? 0.995 : 0.99);
  if (fallingBehind !== micCaptureFallingBehind) {
    micCaptureFallingBehind = fallingBehind;
    console.warn('[mic-capture]', JSON.stringify({ fallingBehind, ...delivery }));
  }
}

/**
 * A fold is inaudible in the mix, but it moves the Mic timeline under every
 * measurement that holds Mic positions; evidence collected across it would
 * splice two placements of the same audio. Applied timing stays: the fold does
 * not change what is heard when.
 */
function reportMicTimelineFolds(nowMs = performance.now()) {
  const folds = session.micTimelineFoldCount;
  if (folds === reportedMicTimelineFolds) return;
  reportedMicTimelineFolds = folds;
  console.warn('[mic-timeline]', JSON.stringify({
    reason: 'capture-loss-folded',
    folds,
    ...session.lastMicTimelineFold,
    correctionAfterMs: Math.round(session.micFrontierCorrectionMs),
    delivery: micCaptureDelivery.status(),
  }));
  calibration.restartWorkingEvidence(nowMs);
  if (contentCalibrationValidator.collecting) contentCalibrationValidator.cancel(nowMs);
  // Only a run in flight: resetting an idle or failed one would play the probe
  // again mid-song.
  if (probeStatus(nowMs).active || bootProbeRuntime.hasMicLeg) abandonProbeRun();
}

/** Who a diagnostic line is about: the room nickname plus a stable id prefix. */
function participantLogLabel(participantId: string) {
  const nickname = participants.participant(participantId)?.nickname ?? null;
  return { id: participantId.replace(/^participant-/, '').slice(0, 8), nickname };
}

let lastMicDeviceReportKey: string | null = null;

/**
 * Names the device and microphone behind the live capture, once per capture
 * and again if either changes, so the level and probe lines around it can be
 * traced to a singer's phone or headset.
 */
function reportMicDevice(health: AudioUplinkHealth) {
  const ownerId = participants.micOwnerId;
  const key = JSON.stringify([ownerId, health.captureGeneration, health.capture]);
  if (key === lastMicDeviceReportKey) return;
  lastMicDeviceReportKey = key;
  console.log('[mic-device]', JSON.stringify({
    participant: ownerId ? participantLogLabel(ownerId) : null,
    captureGeneration: health.captureGeneration,
    device: health.capture?.device ?? null,
    inputLabel: health.capture?.inputLabel ?? null,
    sampleRate: micRuntime.sampleRate,
    voiceProcessing: health.capture === null ? null : {
      echoCancellation: health.capture.echoCancellation,
      noiseSuppression: health.capture.noiseSuppression,
      autoGainControl: health.capture.autoGainControl,
    },
    audioSessionType: health.capture?.audioSessionType ?? null,
    gainDb: session.micGainDb,
  }));
}

/** Gives the new Mic owner the gain they last chose, or the default for a device never seen. */
function restoreMicGainFor(participantId: string) {
  const { gainDb, remembered } = micGains.gainFor(participantId);
  const previousGainDb = session.micGainDb;
  console.log('[mic-gain]', JSON.stringify({
    reason: 'owner-changed',
    participant: participantLogLabel(participantId),
    previousGainDb,
    gainDb,
    remembered,
  }));
  if (gainDb === previousGainDb) return;
  // Not `micLevel.noteMicGainChanged`: the level history still describes the
  // previous singer, and the new owner's capture boundary resets it anyway.
  session.setMicGainDb(gainDb);
  broadcastJson(mixSettingsPayload());
}

function resetMicAudibility() {
  const events = micAudibility.reset();
  micAudibilityReceiverBaseline = null;
  if (events.length > 0) {
    console.warn('[mic-audibility]', JSON.stringify({ events, reason: 'capture-boundary' }));
  }
}

function reportMicAudibility(result: MicAudibilityResult, nowMs: number) {
  // Receiver deltas are per window so a log line says what this second did,
  // not what the capture has accumulated since it started.
  const receiver = micRuntime.receiverStats();
  const baseline = micAudibilityReceiverBaseline;
  micAudibilityReceiverBaseline = receiver;
  if (result.events.length === 0) return;

  const delta = (key: 'receivedPackets' | 'emittedPackets' | 'lostPackets' | 'latePackets'
    | 'reorderedPackets' | 'futurePackets' | 'invalidSampleRangePackets') => (
    receiver && baseline && receiver[key] >= baseline[key]
      ? receiver[key] - baseline[key]
      : null
  );
  const uplink = micRuntime.uplinkHealthPayload(nowMs);
  const health = session.health();
  console.warn('[mic-audibility]', JSON.stringify({
    events: result.events,
    window: {
      ...result.window,
      receivedFraction: Number(result.window.receivedFraction.toFixed(3)),
      missingFraction: Number(result.window.missingFraction.toFixed(3)),
      receivedRmsDbfs: result.window.receivedRmsDbfs === null
        ? null
        : Math.round(result.window.receivedRmsDbfs),
    },
    mediaPath: micMediaPath(),
    micStreaming: micStreaming(nowMs),
    micFrameAgeMs: micRuntime.frameAgeMs(nowMs),
    receiverWindow: receiver ? {
      received: delta('receivedPackets'),
      emitted: delta('emittedPackets'),
      lost: delta('lostPackets'),
      late: delta('latePackets'),
      reordered: delta('reorderedPackets'),
      future: delta('futurePackets'),
      invalidSampleRange: delta('invalidSampleRangePackets'),
      buffered: receiver.bufferedPackets,
    } : null,
    retransmit: micRuntime.retransmitStats(),
    mix: {
      requestedMicAdvanceMs: Math.round(session.requestedMicAdvanceMs),
      appliedMicAdvanceMs: Math.round(session.appliedMicAdvanceMs),
      micFrontierCorrectionMs: Math.round(session.micFrontierCorrectionMs),
      micHeadroomMs: health.micHeadroomMs,
      micGapMs: health.micGapMs,
      micConcealedMs: Math.round((session.micConcealedSampleCount / MIX_SAMPLE_RATE) * 1000),
      micClockDrift: micClockDrift.estimate(),
      micClockTrimPpm: session.micClockTrimPpm,
      micAnchorExcessMs: micClockDrift.anchorExcessMs(),
      micRmsDbfs: health.micRmsDbfs === null ? null : Math.round(health.micRmsDbfs),
    },
    phone: uplink ? {
      reportAgeMs: uplink.reportAgeMs,
      inputMuted: uplink.inputMuted,
      inputGapActive: uplink.inputGapActive ?? null,
      captureLevel: uplink.captureLevel,
      captureDispatch: uplink.captureDispatch ?? null,
      droppedSamples: uplink.droppedSamples,
      transport: uplink.transport,
    } : null,
  }));
}

function maybeAutoCalibrate(nowMs: number) {
  relayContentCalibration.stepAuto(nowMs);
}


function maybeValidateContentCalibration(nowMs: number) {
  relayContentCalibration.stepValidation(nowMs);
}

const relayBootProbe = createRelayBootProbeOrchestration({
  config: {
    sampleRate: MIX_SAMPLE_RATE,
    leadMs: PROBE_LEAD_MS,
    searchMarginMs: PROBE_SEARCH_MARGIN_MS,
    referenceMs: PROBE_REFERENCE_MS,
    analysisTimeoutMs: PROBE_ANALYSIS_TIMEOUT_MS,
    minCorrelation: PROBE_MIN_CORRELATION,
    maxCaptureGapMs: MAX_CAPTURE_GAP_MS,
    reapplyThresholdMs: BOOT_DELTA_REAPPLY_MS,
    debug: PROBE_DEBUG,
  },
  mix: session,
  mic: micRuntime,
  backing: backingRuntime,
  source: sourceRuntime,
  probe: bootProbeRuntime,
  calibration,
  timing: timingRuntime,
  queries: {
    robotRouteActive,
    robotProbeTimingActive,
    takeBlocksCalibration,
    micPlayable,
    backingPlayable,
    calibrationIsStale,
    probeStatus,
    appliedCalibrationKind,
    calibrationApplicability,
    roomHasSong,
    robotDeltaIsFresh,
    currentDeltaMs,
    currentPlaybackRate,
    bootProbeAdvanceMs,
  },
  effects: {
    sendProbe: (target, message) => sendJson(target, message),
    reportTimingStatus: () => broadcastJson(timingCalibrationStatusPayload()),
    debugLog: (message) => console.log(message),
  },
});

function bootProbeContext() {
  return relayBootProbe.context();
}

function failProbeAttempt(target: ProbeTarget, reason: string, nowMs: number) {
  relayBootProbe.failAttempt(target, reason, nowMs);
}

function maybeStartProbeCalibration(nowMs: number) {
  relayBootProbe.stepAdmission(nowMs);
}

function handleProbeReply(reply: { requestId: unknown; generation: unknown }, nowMs: number) {
  relayBootProbe.handleReply(reply, nowMs);
}

function handleProbeFailure(
  reply: { requestId: unknown; generation: unknown; reason: unknown },
  nowMs: number,
) {
  relayBootProbe.handleFailure(reply, nowMs);
}

function maybeFinishProbeAnalysis(nowMs: number) {
  relayBootProbe.stepAnalysis(nowMs);
}

function currentDeltaMs(nowMs: number) {
  return robotDeltaIsFresh(nowMs) ? robotPlayerOffset.offsetMs(nowMs)! : 0;
}

/**
 * Keeps the boot baseline on the mixer, and lets it reclaim the mixer when the
 * authority that replaced it can no longer drive one.
 *
 * The boot probe measures *pipeline* latency with a known tone, so its result
 * does not depend on where the Robot's player happens to be - `bootProbeContext()`
 * deliberately leaves the source generation out for exactly that reason. A seek
 * invalidates content's reference frame, because content is measured between two
 * content streams and one of them was just spliced at an unknown sample. It says
 * nothing about the pipeline.
 *
 * Without a reclaim path that distinction is lost: content dies and the mixer
 * drops straight to the network estimate while a still-valid measurement sits in
 * the probe runtime. That is a step down two levels instead of one, and the room
 * hears the whole difference.
 *
 * Reclaiming deliberately waits for `calibration.collecting` to be false, since
 * `applyExternalResult()` would otherwise discard an in-flight content retry -
 * and for a fresh delta, since the total is only meaningful with one.
 */
function maybeReapplyBootCalibration(nowMs: number) {
  relayBootProbe.stepReapply(nowMs);
}

/**
 * Retires a content calibration that belongs to the pre-Robot route.
 *
 * This exists because a route can *become* Robot underneath a content run that
 * was measured for a legacy backing path. It must not touch a content run the
 * Robot route started for itself: once the boot probe has settled, content is
 * the strategy this route is supposed to be running, and resetting it here also
 * discards the confirmed boot result, dropping the live mixer to its network
 * estimate mid-upgrade.
 */
function dropLegacyCalibrationForRobot() {
  relayRobotMapping.dropLegacyCalibration();
}

// Command authority and product action availability stay in the command handler.
// Calibration, timing and probe state authority stay in their existing runtimes;
// this seam owns only the already-authorized manual transaction ordering.


function restartManualBootCalibration(nowMs: number) {
  relayCalibrationLifecycle.restartManualBootCalibration(nowMs);
}

const youtubeTimelineTimer = setInterval(() => {
  const nowMs = performance.now();

  if (
    youtubeTimeline.hasTelemetry
    && nowMs - lastTelemetryTimelineBroadcastAtMs >= TIMELINE_STATUS_REFRESH_MS
  ) {
    broadcastJson(youtubeTimeline.statusPayload(nowMs));
    broadcastJson(youtubeTimeline.roomStatusPayload(nowMs));
  }

  relaySongCommands.stepExpiry(nowMs);

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

  const expiredProbe = bootProbeRuntime.takeExpiredRequest(nowMs, PROBE_REPLY_TIMEOUT_MS);
  if (expiredProbe) {
    failProbeAttempt(expiredProbe.target, 'playback acknowledgement timed out', nowMs);
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
}, TIMELINE_STATUS_REFRESH_MS);

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

function validSampleCursor(value: unknown) {
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor) || cursor < 0) return null;
  return cursor;
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
  standDownContentCalibration: () => calibration.abandon(),
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

type RecordingMicGapHealthBaseline = {
  takeId: string;
  captureGeneration: number;
  inputGapSamples: number;
  inputGapActive: boolean;
};

let recordingMicGapHealthBaseline: RecordingMicGapHealthBaseline | null = null;

function noteRecordingMicGapHealth(health: AudioUplinkHealth) {
  const takeId = takeController.recordingTakeId;
  if (!takeId || health.inputGapActiveObserved !== true) {
    recordingMicGapHealthBaseline = null;
    return false;
  }

  const previous = recordingMicGapHealthBaseline;
  const current: RecordingMicGapHealthBaseline = {
    takeId,
    captureGeneration: health.captureGeneration,
    inputGapSamples: health.inputGapSamples,
    inputGapActive: health.inputGapActive === true,
  };
  recordingMicGapHealthBaseline = current;

  // The first explicit source-health snapshot inside a Take is only a baseline.
  // A cumulative delta first observed after Start may have happened before the
  // recording boundary, so attributing it would create a permanent false
  // positive in Take metadata. Subsequent same-generation snapshots bound the
  // event entirely inside this recording's observed source-health window.
  if (
    !previous
    || previous.takeId !== takeId
    || previous.captureGeneration !== health.captureGeneration
  ) return false;

  if (
    previous.inputGapActive !== true
    && health.inputGapSamples > previous.inputGapSamples
  ) {
    return takeController.noteQualityEvent('mic-input-gap');
  }
  return false;
}

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

    relayMicLifecycle.release({
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

    relaySongCommands.accept({
      socket,
      command: decision.command,
      duplicate: decision.duplicate,
      nowMs,
    });
  },
  roomSongCommandFailed: (socket, payload) => {
    const playbackIdentity = playbackTransport.identity(socket);
    if (!playbackIdentity) return;
    const nowMs = performance.now();
    relaySongCommands.failPending(playbackIdentity, payload.commandId, nowMs);
  },
  songHandoffReady: (socket, payload) => {
    const playbackIdentity = playbackTransport.identity(socket);
    if (!playbackIdentity) return;
    relaySongLifecycle.ready({
      identity: playbackIdentity,
      handoffId: payload.handoffId,
      micOwnerId: participants.micOwnerId,
    });
  },
  songHandoffFailed: (socket, payload) => {
    const playbackIdentity = playbackTransport.identity(socket);
    if (!playbackIdentity) return;
    relaySongLifecycle.failed({
      identity: playbackIdentity,
      handoffId: payload.handoffId,
    });
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
    relaySongLifecycle.continueRegistration({
      socket,
      identity: playbackIdentity,
    });
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
      relaySongLifecycle.acceptTelemetry({
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
      const previousGainDb = session.micGainDb;
      session.setMicGainDb(Math.max(0, Math.min(MAX_MIC_GAIN_DB, nextGain)));
      if (participants.micOwnerId) micGains.remember(participants.micOwnerId, session.micGainDb);
      // A gain change is the fix the level warning asks for; answer it now
      // rather than on the next periodic product status.
      if (micLevel.noteMicGainChanged(previousGainDb, session.micGainDb)) {
        reportMicLevel('gain');
        broadcastProductStatus();
      }
    }
    // `songLevel` remains accepted on the old wire shape for compatibility,
    // but Song is now a server-owned 100% reference and cannot be mutated by
    // any client authority.
    broadcastJson(mixSettingsPayload());
    return;
  },
  audioUplinkHealth: (socket, payload) => {
    const health = parseAudioUplinkHealth(payload);
    if (!health) return;

    const nowMs = performance.now();
    const accepted = micRuntime.noteUplinkHealth(socket, health, nowMs);
    if (accepted) noteRecordingMicGapHealth(health);
    if (accepted) reportMicDevice(health);
    if (accepted) noteMicCaptureDelivery(health, nowMs);
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
    // Rounded here too, so a page that still sends full precision does not
    // cost every listener for it.
    broadcastJson({
      type: 'room-mic-presence',
      version: 1,
      ownerId: micRuntime.mediaOwnerId,
      captureGeneration: micRuntime.mediaGeneration,
      ...micPresenceDisplayValues(presence),
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
          calibration.fail('Connect both the Mic and Desktop Source before calibration.');
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
          calibration.fail('Play the song before calibration.');
          return;
        case 'robot-route-incomplete':
          // Not "connect your devices": on a Robot route the second leg is
          // this machine's own browser, and its recovery is the route unit.
          sendJson(socket, {
            type: 'calibration-command-rejected',
            reason: 'robot-route-incomplete',
          });
          return;
        case 'content-mapping-pending':
          sendJson(socket, {
            type: 'calibration-command-rejected',
            reason: 'content-mapping-pending',
          });
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
  robotPlayerStatus: (socket, payload) => {
    if (!sourceRuntime.isActiveRobot(socket)) return;
    const videoId = typeof payload.videoId === 'string' && /^[A-Za-z0-9_-]{11}$/.test(payload.videoId)
      ? payload.videoId
      : null;
    const errorCode = Number.isInteger(payload.errorCode) ? Number(payload.errorCode) : null;
    noteRobotPlayerStatus(videoId, errorCode);
    return;
  },
  robotPlayerOffset: (socket, payload) => {
    const offsetMs = Number(payload.offsetMs);
    if (!sourceRuntime.isActiveRobot(socket) || !Number.isFinite(offsetMs)) return;
    const nowMs = performance.now();
    if (Math.abs(offsetMs) > ROBOT_PLAYER_OFFSET_MAX_ABS_MS) {
      // A minutes-wide media-position gap is a convergence problem, never an
      // acoustic timing measurement. This is a fail-closed fence, so it has to
      // invalidate the reference frame too: clearing only the tracker and the
      // mapper would leave the confirmed content result matching the live
      // context, ready to be re-applied as soon as a bounded residual arrives.
      revokeRobotContentMapping({
        reason: 'The Robot player jumped away from the room timeline.'
          + ' Rebuilding the Robot content mapping before calibration retries.',
      });
      return;
    }
    robotPlayerOffset.record(offsetMs, nowMs);
    const mapped = robotContentTimeline.notePlayerOffset(
      robotPlayerOffset.offsetMs(nowMs) ?? offsetMs,
      calibrationContext(),
      nowMs,
      currentPlaybackRate(nowMs),
    );
    if (mapped) requestRobotBackingBoundary(nowMs);
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
    // Source always converges gross media-time error. Only preserve the old
    // mapping through that seek when Relay already has a proven content anchor;
    // otherwise the existing coordinator deliberately treats it as a
    // destructive bootstrap remap and clears stale transition state.
    const mappedFollowerCorrection = requestedFollowerCorrection
      && sourceRuntime.isActiveRobot(socket)
      && backingRuntime.isRobot
      && robotFollowerSeekMayPreserveMapping(nowMs)
      && robotContentTimeline.noteFollowerCorrection(
        fromMediaTime,
        toMediaTime,
        context,
        nowMs,
      );

    relayRobotMapping.handleSourceSeek({
      mappedFollowerCorrection,
      fromMediaTime,
      toMediaTime,
      preDeltaMs,
      referenceDeltaMs,
      context,
      nowMs,
    });
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


    relayMicLifecycle.activate({
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

    const hasCaptureGeneration = Object.prototype.hasOwnProperty.call(payload, 'captureGeneration');
    const hasCaptureSampleCursor = Object.prototype.hasOwnProperty.call(payload, 'captureSampleCursor');
    if (hasCaptureGeneration !== hasCaptureSampleCursor) {
      sendJson(socket, {
        type: 'error',
        message: 'Backing capture identity requires generation and sample cursor together.',
      });
      return;
    }

    let captureReplaced = false;
    if (hasCaptureGeneration) {
      const captureGeneration = validCaptureGeneration(payload.captureGeneration);
      const captureSampleCursor = validSampleCursor(payload.captureSampleCursor);
      if (captureGeneration === null || captureSampleCursor === null) {
        sendJson(socket, { type: 'error', message: 'Invalid backing capture identity.' });
        return;
      }
      captureReplaced = session.backingCaptureReplacedBy({
        generation: captureGeneration,
        sourceRate: sampleRate,
        sampleCursor: captureSampleCursor,
      });
    }

    commitSocketRole(socket, 'backing');

    relayBackingLifecycle.activate({
      socket,
      sampleRate,
      robot: payload.robot === true,
      captureReplaced,
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

    // Opus rides only positioned monitor frames, and only for a page that
    // said it can decode it, on a Relay that has it enabled and loaded.
    const monitorCodec = monitorPacketVersion === 1
      && Array.isArray(payload.monitorCodecs)
      && payload.monitorCodecs.includes('opus')
      && monitorTransport.opusEnabled
      ? 'opus' as const
      : undefined;

    commitSocketRole(socket, 'monitor');
    socket.monitorPacketVersion = monitorPacketVersion;
    socket.monitorCodec = monitorCodec;
    // The room audio shares this TCP stream and its backlog budget with every
    // status broadcast. A page that names the few it reads here gets only
    // those; at Opus bitrates the rest was as much traffic as the audio.
    socket.broadcastTypes = parseBroadcastTypes(payload.broadcastTypes);
    sendJson(socket, {
      type: 'registered',
      role: 'monitor',
      ...(monitorPacketVersion ? { monitorPacketVersion } : {}),
      ...(monitorCodec ? { monitorCodec } : {}),
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

const robotLifecycleProtocol = createRelayRobotLifecycleProtocol<RelaySocket>({
  robotSourceHello: (socket, payload) => {
    if (!infrastructureCapability.authorized(socket)) {
      rejectInfrastructure(socket, 'Authenticate Relay infrastructure before becoming the Robot source.');
      return;
    }
    if (sourceRuntime.isActive(socket)) return;

    const { previous, replaced } = sourceRuntime.attachRobot(socket);
    relayRobotMapping.activateSource({ previous, replaced });
    return;
  },
});

const audioUplinkCoordinator = createRelayAudioUplinkCoordinator<RelaySocket>({
  isMicPublisher: (socket) => micRuntime.isPublisher(socket),
  receiveMic: (socket, data, nowMs) => {
    relayMixPump.deliver(micRuntime.receivePublisher(socket, data, nowMs));
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
    relayBackingLifecycle.restartCapture({
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
    if (monitorTransport.acknowledge(socket, payload)) return;
    if (subscribeBroadcasts(socket, payload)) return;
    if (queryProtocol.dispatch(socket, payload)) return;
    if (commandProtocol.dispatch(socket, payload)) return;
    if (infrastructureEventProtocol.dispatch(socket, payload)) return;
    if (authenticationProtocol.dispatch(socket, payload)) return;
    if (registrationProtocol.dispatch(socket, payload)) return;
    if (robotLifecycleProtocol.dispatch(socket, payload)) return;






  });

  socket.on('close', () => {
    relaySongLifecycle.disconnect(socket);
    let micTransportChanged = false;

    if (!socket.replaced) {
      relayRobotMapping.disconnectSource(socket);
      micTransportChanged = relayMicLifecycle.disconnect(socket);

      relayBackingLifecycle.disconnect(socket);
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
  relayMixPump.stop();
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

if (relayConfig.listenOpus) {
  try {
    monitorTransport.enableOpus(await loadMonitorOpusEncoder({
      sampleRate: MIX_SAMPLE_RATE,
      bitrate: relayConfig.listenOpusBitrate,
    }));
    console.log(`Relay Listen offers Opus at ${relayConfig.listenOpusBitrate / 1_000} kbps`);
  } catch (error) {
    console.warn('Relay Listen Opus is unavailable; listeners stay on PCM.', error);
  }
}

const directMediaConfig = webTransportMediaConfig();
if (directMediaConfig) {
  try {
    await webTransportMedia.start(directMediaConfig, {
      authorize(ticket) {
        return micRuntime.authorizeDirectMedia(ticket);
      },
      onDatagram(ticket, packet, nowMs) {
        relayMixPump.deliver(micRuntime.receiveDirectMedia(ticket, packet, nowMs));
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
    relayMixPump.stop();
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
