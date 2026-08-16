import { createServer, type IncomingMessage } from 'node:http';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import express from 'express';
import WebSocket, { WebSocketServer } from 'ws';

import { AudioSession, LIMITER_THRESHOLD_DBFS } from './audio-session.js';
import { combineBootCalibration, type BootCalibrationResult } from './boot-calibration.js';
import { locateProbe, PROBE_REFERENCE_MS } from './calibration-probe.js';
import { CalibrationSession, type CalibrationContext } from './calibration-session.js';
import { authorizeMicOwnerCommand, type MicOwnerCommand } from './command-authority.js';
import { decodePcmFrame } from './pcm-frame.js';
import {
  ParticipantSession,
  normalizeNickname,
  normalizeParticipantId,
} from './participant-session.js';
import { parseRoomSongCommand } from './room-song-command.js';
import {
  RoomSongCommandSession,
  type AcceptedRoomSongCommand,
} from './room-song-command-session.js';
import {
  SongSession,
  normalizePlaybackGeneration,
  normalizePlaybackTransportId,
  type PlaybackIdentity,
  type SongHandoffPlan,
} from './song-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../public');
const port = Number(process.env.PORT ?? 3000);
const relayKey = process.env.RELAY_KEY ?? null;

function envMs(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const MIX_SAMPLE_RATE = 48_000;
const MIX_FRAME_MS = 20;
const MIX_FRAME_SAMPLES = Math.round((MIX_SAMPLE_RATE * MIX_FRAME_MS) / 1000);
const TEST_BPM = 120;
const TEST_PREBUFFER_MS = 800;
const LIVE_MIX_PREBUFFER_MS = envMs('RELAY_LIVE_PREBUFFER_MS', 400);
const LIVE_BACKING_GAIN = 0.65;
const MAX_OFFSET_MS = 500;
const MIC_RETENTION_MS = envMs('RELAY_MIC_RETENTION_MS', 3_000);
/**
 * How far either side of the estimated position a probe is searched for.
 *
 * This bounds the latency a probe can find at all, so it has to cover the
 * whole plausible range of a path rather than just the round-trip estimate's
 * error. The robot's browser-to-PipeWire path measured close to two seconds,
 * which a 400 ms window would have silently missed.
 */
const PROBE_SEARCH_MARGIN_MS = envMs('RELAY_CALIBRATION_PROBE_SEARCH_MARGIN_MS', 3_000);
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
const TIMING_CALIBRATION_TIMEOUT_MS = envMs('RELAY_CALIBRATION_TIMEOUT_MS', 20_000);
const MAX_VOCAL_FINE_TUNE_MS = 100;
const HEARTBEAT_MS = envMs('RELAY_HEARTBEAT_MS', 8_000);
const MIX_HEALTH_INTERVAL_MS = 1_000;
const PARTICIPANT_GRACE_MS = envMs('RELAY_PARTICIPANT_GRACE_MS', 5_000);
const MIC_TRANSPORT_GRACE_MS = envMs('RELAY_MIC_TRANSPORT_GRACE_MS', 5_000);
const PLAYBACK_MIC_INTENT_MS = 10_000;

const app = express();
app.disable('x-powered-by');
app.use(express.static(publicDir));
app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
const participants = new ParticipantSession(PARTICIPANT_GRACE_MS);
const youtubeTimeline = new SongSession();
const roomSongCommands = new RoomSongCommandSession();
let roomSongCommandRevision = 0;

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }

  if (relayKey && url.searchParams.get('key') !== relayKey) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (webSocket) => {
    wss.emit('connection', webSocket, request);
  });
});

type ClientRole = 'publisher' | 'monitor' | 'backing' | 'unknown';
type CalibrationKind = 'none' | 'content' | 'boot-probe';
type RelaySocket = WebSocket & {
  role: ClientRole;
  sampleRate?: number;
  captureGeneration?: number;
  isAlive: boolean;
  replaced?: boolean;
  isRobotSource?: boolean;
  participantId?: string;
  participantConnectionId?: string;
  playbackParticipantId?: string;
  playbackTransportId?: string;
  playbackGeneration?: number;
  playbackMicIntentAtMs?: number;
  legacyPlaybackGeneration?: number;
  telemetryRejectedReason?: string;
};

type TimelineStatus = {
  connected?: boolean;
  videoId?: string;
  state?: number;
  serverTime?: number;
  playbackRate?: number;
  transportEstimateMs?: number;
};

let publisher: RelaySocket | null = null;
let publisherSampleRate: number | null = null;
let backing: RelaySocket | null = null;
let backingSampleRate: number | null = null;
let backingIsRobot = false;
let activeRobotSource: RelaySocket | null = null;
let micGainDb = 24;
let songLevel = 40;
let testActive = false;
let testStartedAt = 0;
let testFrameIndex = 0;
let monitorDroppedFrames = 0;
let lastMixHealthAt = 0;
let participantConnectionSequence = 0;
let legacyPlaybackConnectionSequence = 0;
/**
 * The single synthetic playback identity shared by pre-participant clients.
 *
 * There is only ever one anonymous publisher transport at a time, so this is
 * one logical device rather than a population; each connection is a newer
 * incarnation of it, distinguished by `legacyPlaybackGeneration`.
 */
const LEGACY_PLAYBACK_PARTICIPANT_ID = '__relay_legacy_publisher__';
const LEGACY_PLAYBACK_TRANSPORT_ID = 'legacy-publisher';
let micTransportGraceTimer: NodeJS.Timeout | null = null;
let micTransportGraceOwnerId: string | null = null;

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
session.setMicGainDb(micGainDb);

let sourceGeneration = 0;
const AUTO_CALIBRATE = process.env.RELAY_AUTO_CALIBRATE !== '0';
const AUTO_CALIBRATION_RETRY_MS = envMs('RELAY_AUTO_CALIBRATION_RETRY_MS', 15_000);
let lastAutoCalibrationAt = -Infinity;
let calibrationWasAutomatic = false;
let calibrationKind: CalibrationKind = 'none';

const PROBE_CALIBRATE = process.env.RELAY_CALIBRATION_PROBE !== '0';
const PROBE_RETRY_MS = envMs('RELAY_CALIBRATION_PROBE_RETRY_MS', 6_000);
const PROBE_LEAD_MS = envMs('RELAY_CALIBRATION_PROBE_LEAD_MS', 200);
const PROBE_MIN_CORRELATION = Number(process.env.RELAY_CALIBRATION_PROBE_MIN_CORRELATION ?? 0.5);
const PROBE_DEBUG = process.env.RELAY_CALIBRATION_PROBE_DEBUG === '1';
const PROBE_REPLY_TIMEOUT_MS = 3_000;
/**
 * Long enough for the probe to play, be captured and reach the server.
 *
 * Derived from the search window rather than set independently: the analysis
 * cannot run until the timeline has covered the whole window, so a timeout
 * shorter than that rejects every probe before it is even looked at. Raising
 * `RELAY_CALIBRATION_PROBE_SEARCH_MARGIN_MS` to 10 s did exactly that, and the
 * only symptom was every leg reporting `analysis dropped ... timedOut=true`.
 */
const PROBE_ANALYSIS_TIMEOUT_MS = Math.max(
  envMs('RELAY_CALIBRATION_PROBE_ANALYSIS_TIMEOUT_MS', 8_000),
  PROBE_SEARCH_MARGIN_MS + PROBE_REFERENCE_MS + 5_000,
);

type ProbeTarget = 'mic' | 'backing';
type MeasuredMicLeg = {
  targetSample: number;
  actualSample: number;
  correlation: number;
  sessionGeneration: number;
  micGeneration: number | null;
};

let lastProbeAttemptAt = -Infinity;
let probeRequestId = 0;
let pendingProbe: {
  target: ProbeTarget;
  requestId: number;
  serverSentAtMs: number;
  generation: number | null;
} | null = null;
let pendingProbeAnalysis: {
  target: ProbeTarget;
  targetSample: number;
  windowStart: number;
  windowSamples: number;
  generation: number | null;
  deadlineMs: number;
} | null = null;
let measuredMicLeg: MeasuredMicLeg | null = null;
let lastProbeCorrelation: { mic: number | null; backing: number | null } = { mic: null, backing: null };
let lastProbeContext: {
  sessionGeneration: number;
  micGeneration: number | null;
  backingGeneration: number | null;
} | null = null;
let robotPlayerOffsetMs: number | null = null;
let robotPlayerOffsetAt = -Infinity;
let lastBootCalibration: BootCalibrationResult | null = null;
let bootPathDifferenceMs: number | null = null;
let bootConfidence: number | null = null;
const BOOT_DELTA_REAPPLY_MS = envMs('RELAY_CALIBRATION_DELTA_REAPPLY_MS', 40);
const ROBOT_OFFSET_FRESH_MS = 2_000;

const STREAM_LIVE_MS = 1_000;
const COLLECTION_SILENCE_GRACE_MS = 1_500;
let lastMicFrameAt = -Infinity;
let lastBackingFrameAt = -Infinity;

function bothStreamsFlowing(nowMs: number) {
  return silentSides(nowMs).length === 0;
}

function silentSides(nowMs: number) {
  const silent: string[] = [];
  if (nowMs - lastMicFrameAt >= STREAM_LIVE_MS) silent.push('phone microphone');
  if (nowMs - lastBackingFrameAt >= STREAM_LIVE_MS) silent.push('desktop capture');
  return silent;
}

const BACKING_GRACE_MS = envMs('RELAY_BACKING_GRACE_MS', 10_000);
let backingAbsenceTimer: NodeJS.Timeout | null = null;

function cancelBackingGrace() {
  if (backingAbsenceTimer === null) return;
  clearTimeout(backingAbsenceTimer);
  backingAbsenceTimer = null;
}

function cancelMicTransportGrace() {
  if (micTransportGraceTimer !== null) clearTimeout(micTransportGraceTimer);
  micTransportGraceTimer = null;
  micTransportGraceOwnerId = null;
}

function scheduleMicTransportGrace(ownerId: string) {
  cancelMicTransportGrace();
  micTransportGraceOwnerId = ownerId;
  micTransportGraceTimer = setTimeout(() => {
    micTransportGraceTimer = null;
    const expectedOwnerId = micTransportGraceOwnerId;
    micTransportGraceOwnerId = null;
    if (!expectedOwnerId || participants.micOwnerId !== expectedOwnerId) return;
    if (
      publisher?.readyState === WebSocket.OPEN
      && publisher.participantId === expectedOwnerId
    ) return;

    const released = participants.releaseMic(expectedOwnerId);
    if (!released.ok) return;
    invalidateMicTiming('Microphone transport did not reconnect before its grace period expired.');
    broadcastSessionStatus();
  }, MIC_TRANSPORT_GRACE_MS);
  micTransportGraceTimer.unref();
}

function calibrationContext(): CalibrationContext {
  return {
    sessionGeneration: session.generation,
    micGeneration: session.micGeneration,
    backingGeneration: session.backingGeneration,
    sourceGeneration,
  };
}

function robotRouteActive() {
  return PROBE_CALIBRATE && (
    backingIsRobot
    || activeRobotSource?.readyState === WebSocket.OPEN
  );
}

function robotDeltaIsFresh(nowMs = performance.now()) {
  return activeRobotSource?.readyState === WebSocket.OPEN
    && robotPlayerOffsetMs !== null
    && nowMs - robotPlayerOffsetAt <= ROBOT_OFFSET_FRESH_MS;
}

const calibration = new CalibrationSession({
  sampleRate: MIX_SAMPLE_RATE,
  durationMs: TIMING_CALIBRATION_MS,
  timeoutMs: TIMING_CALIBRATION_TIMEOUT_MS,
  context: calibrationContext,
  agreementWindows: Number(process.env.RELAY_CALIBRATION_AGREEMENT ?? 3),
  agreementToleranceMs: envMs('RELAY_CALIBRATION_TOLERANCE_MS', 25),
  provisionalConfidence: Number(process.env.RELAY_CALIBRATION_PROVISIONAL_CONFIDENCE ?? 0.55),
  maxLagMs: envMs('RELAY_CALIBRATION_MAX_LAG_MS', 2_500),
  onSettled: () => {
    syncAppliedCalibration();
    broadcastJson(timingCalibrationStatusPayload());
    broadcastJson(sourceStatusPayload());
  },
});

function sendJson(socket: WebSocket, payload: unknown) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function broadcastJson(payload: unknown) {
  const message = JSON.stringify(payload);
  for (const client of wss.clients) {
    const socket = client as RelaySocket;
    if (socket.readyState === WebSocket.OPEN) socket.send(message);
  }
}

function participantIdentity(request: IncomingMessage) {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const participantId = normalizeParticipantId(url.searchParams.get('participant'));
  if (!participantId) return null;

  const nickname = normalizeNickname(url.searchParams.get('name')) ?? 'Guest';
  return { participantId, nickname };
}

function sessionStatusPayload() {
  const snapshot = participants.snapshot();
  return {
    type: 'session-status',
    ...snapshot,
    micConnected: snapshot.micOwnerId !== null
      && publisher?.readyState === WebSocket.OPEN
      && publisher.participantId === snapshot.micOwnerId,
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
      isCurrentPublisher: socket === publisher && socket.role === 'publisher',
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

function playbackIdentityForSocket(socket: RelaySocket): PlaybackIdentity | null {
  if (
    !socket.playbackParticipantId
    || !socket.playbackTransportId
    || socket.playbackGeneration === undefined
  ) return null;
  return {
    participantId: socket.playbackParticipantId,
    transportId: socket.playbackTransportId,
    generation: socket.playbackGeneration,
  };
}

function samePlaybackIdentity(a: PlaybackIdentity, b: PlaybackIdentity) {
  return a.participantId === b.participantId
    && a.transportId === b.transportId
    && a.generation === b.generation;
}

function sendToPlayback(identity: PlaybackIdentity, payload: unknown) {
  let sent = 0;
  for (const client of wss.clients) {
    const candidate = client as RelaySocket;
    const candidateIdentity = playbackIdentityForSocket(candidate);
    if (
      candidate.readyState === WebSocket.OPEN
      && candidateIdentity
      && samePlaybackIdentity(candidateIdentity, identity)
    ) {
      sendJson(candidate, payload);
      sent += 1;
    }
  }
  return sent;
}

function roomSongCommandStatusPayload(nowMs = performance.now()) {
  return roomSongCommands.statusPayload(roomSongCommandRevision, nowMs);
}

function roomSongCommandApplyPayload(command: AcceptedRoomSongCommand) {
  return {
    type: 'room-song-command-apply',
    commandId: command.commandId,
    revision: command.revision,
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
    revision: roomSongCommandRevision,
    room: youtubeTimeline.roomStatusPayload(),
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
  return sendToPlayback(plan.target, handoffPayload(type, plan));
}

function selectPlaybackHandoffTarget(participantId: string, nowMs: number) {
  const candidates: Array<{ identity: PlaybackIdentity; intentAtMs: number }> = [];
  for (const client of wss.clients) {
    const candidate = client as RelaySocket;
    const identity = playbackIdentityForSocket(candidate);
    if (
      candidate.readyState !== WebSocket.OPEN
      || !identity
      || identity.participantId !== participantId
    ) continue;
    candidates.push({ identity, intentAtMs: candidate.playbackMicIntentAtMs ?? -Infinity });
  }

  const intended = candidates
    .filter((candidate) => nowMs - candidate.intentAtMs <= PLAYBACK_MIC_INTENT_MS)
    .sort((a, b) => b.intentAtMs - a.intentAtMs);
  if (intended.length > 0) return intended[0].identity;

  // Presence alone must never move the song. This fallback is used only after
  // a microphone ownership action, and only when one playback transport exists
  // so there is no multi-tab choice to guess.
  return candidates.length === 1 ? candidates[0].identity : null;
}

function playbackTransportIsConnected(identity: PlaybackIdentity) {
  for (const client of wss.clients) {
    const candidate = client as RelaySocket;
    if (candidate.readyState !== WebSocket.OPEN) continue;
    const candidateIdentity = playbackIdentityForSocket(candidate);
    if (candidateIdentity && samePlaybackIdentity(candidateIdentity, identity)) return true;
  }
  return false;
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
  if (!youtubeTimeline.sweepHandoff(playbackTransportIsConnected(target), nowMs)) return false;

  sendToPlayback(target, { type: 'song-handoff-cancelled' });
  broadcastJson(youtubeTimeline.statusPayload(nowMs));
  broadcastJson(youtubeTimeline.roomStatusPayload(nowMs));
  return true;
}

function beginPreparedSongHandoff(participantId: string, nowMs = performance.now()) {
  const target = selectPlaybackHandoffTarget(participantId, nowMs);
  if (!target) return false;
  const plan = youtubeTimeline.beginHandoff(target, participants.micOwnerId, nowMs);
  if (!plan) return false;
  sendHandoffPlan('song-handoff-prepare', plan);
  broadcastJson(youtubeTimeline.statusPayload(nowMs));
  broadcastJson(youtubeTimeline.roomStatusPayload(nowMs));
  return true;
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

function broadcastToMonitors(payload: string | Buffer, binary = false) {
  for (const client of wss.clients) {
    const socket = client as RelaySocket;
    if (socket.role !== 'monitor' || socket.readyState !== WebSocket.OPEN) continue;
    if (binary && socket.bufferedAmount > 512 * 1024) {
      monitorDroppedFrames += 1;
      continue;
    }
    socket.send(payload, { binary });
  }
}

function replacePrevious(previous: RelaySocket | null, next: RelaySocket, message: string) {
  if (!previous || previous === next) return;
  previous.replaced = true;
  previous.role = 'unknown';
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
  previous.role = 'unknown';
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
    connected: publisher?.readyState === WebSocket.OPEN,
    sampleRate: publisherSampleRate,
  };
}

function calibrationIsStale() {
  return calibration.isStaleFor(calibrationContext());
}

function calibrationCanApply() {
  const result = calibration.result;
  if (result === null || calibrationIsStale()) return false;
  if (robotRouteActive() && calibrationKind !== 'boot-probe') return false;
  // Boot calibration is a three-term equation. The two probe legs may be
  // measured ahead of playback, but an unknown player delta is not zero. Keep
  // the path result as evidence and stay on the network fallback until the
  // active robot has published a fresh, settled delta.
  if (robotRouteActive() && calibrationKind === 'boot-probe' && !robotDeltaIsFresh()) return false;
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
  const active = session.alignment.calibratedMicLagMs;

  if (robotRouteActive() && calibrationKind === 'boot-probe') {
    if (!calibrationCanApply()) {
      if (active === null) return false;
      session.setAlignment({ calibratedMicLagMs: null });
      return true;
    }

    if (active !== null) return false;

    const result = calibration.result;
    const storedDeltaMs = lastBootCalibration?.deltaMs;
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

  const nextMicLagMs = calibrationCanApply() ? calibration.result!.micLagMs : null;
  if (active === nextMicLagMs) return false;
  session.setAlignment({ calibratedMicLagMs: nextMicLagMs });
  return true;
}

function sourceStatusPayload() {
  const alignment = session.alignment;
  const calibrationStatus = calibration.status();
  const nowMs = performance.now();
  return {
    type: 'source-status',
    connected: backing?.readyState === WebSocket.OPEN,
    micConnected: publisher?.readyState === WebSocket.OPEN,
    backingStreaming: nowMs - lastBackingFrameAt < STREAM_LIVE_MS,
    micStreaming: nowMs - lastMicFrameAt < STREAM_LIVE_MS,
    sampleRate: backingSampleRate,
    active: session.active,
    prebufferMs: session.prebufferMs,
    mixSampleRate: MIX_SAMPLE_RATE,
    micNetworkCompensationMs: alignment.networkCompensationMs,
    calibratedMicLagMs: calibrationStatus.micLagMs,
    activeCalibratedMicLagMs: alignment.calibratedMicLagMs,
    timingMode: alignment.calibratedMicLagMs === null ? 'network-estimate' : 'acoustic-calibration',
    calibrationStale: calibrationIsStale(),
    calibrationKind,
    robotRoute: robotRouteActive(),
    robotSourceConnected: activeRobotSource?.readyState === WebSocket.OPEN,
    robotDeltaFresh: robotDeltaIsFresh(nowMs),
    vocalFineTuneMs: alignment.fineTuneMs,
    appliedMicAdvanceMs: session.appliedMicAdvanceMs,
    requestedMicAdvanceMs: session.requestedMicAdvanceMs,
  };
}

function mixHealthPayload() {
  const health = session.health();
  return {
    type: 'mix-health',
    active: session.active,
    ...health,
    recommendedMicGainDb: recommendedMicGainDb(health.micPeakDbfs),
    micGainDb,
    monitorDroppedFrames,
    prebufferMs: session.prebufferMs,
  };
}

function recommendedMicGainDb(micPeakDbfs: number | null) {
  if (micPeakDbfs === null || !Number.isFinite(micPeakDbfs)) return null;
  return Math.max(0, Math.min(36, Math.round(LIMITER_THRESHOLD_DBFS - micPeakDbfs)));
}

function timingCalibrationStatusPayload() {
  const alignment = session.alignment;
  const status = calibration.status();
  const nowMs = performance.now();
  return {
    type: 'timing-calibration-status',
    ...status,
    activeMicLagMs: alignment.calibratedMicLagMs,
    timingMode: alignment.calibratedMicLagMs === null ? 'network-estimate' : 'acoustic-calibration',
    calibrationStale: calibrationIsStale(),
    calibrationKind,
    robotRoute: robotRouteActive(),
    robotSourceConnected: activeRobotSource?.readyState === WebSocket.OPEN,
    robotDeltaFresh: robotDeltaIsFresh(nowMs),
    fallbackNetworkMs: alignment.networkCompensationMs,
    vocalFineTuneMs: alignment.fineTuneMs,
    appliedMicAdvanceMs: session.appliedMicAdvanceMs,
    requestedMicAdvanceMs: session.requestedMicAdvanceMs,
    probeCorrelation: lastProbeCorrelation,
    bootCalibration: lastBootCalibration,
    robotPlayerOffsetMs: robotDeltaIsFresh(nowMs) ? robotPlayerOffsetMs : null,
    automatic: calibrationWasAutomatic,
    autoCalibrate: AUTO_CALIBRATE,
  };
}

function testStatusPayload() {
  return {
    type: 'test-status',
    active: testActive,
    mode: testActive ? 'click' : 'off',
    bpm: testActive ? TEST_BPM : 0,
    sampleRate: MIX_SAMPLE_RATE,
    prebufferMs: testActive ? TEST_PREBUFFER_MS : 0,
  };
}

function mixSettingsPayload() {
  return {
    type: 'mix-settings',
    micGainDb,
    songLevel,
  };
}

function currentTimelineStatus(nowMs = performance.now()) {
  return youtubeTimeline.statusPayload(nowMs) as TimelineStatus & Record<string, unknown>;
}

function broadcastStatus() {
  broadcastToMonitors(JSON.stringify(publisherStatusPayload()));
  broadcastJson(sourceStatusPayload());
}

function revokePublisherTransport(message: string) {
  const previous = publisher;
  if (!previous) return false;
  publisher = null;
  publisherSampleRate = null;
  session.setMicExpected(false);
  retirePublisherTransport(previous, 'mic-revoked', message);
  if (testActive) stopSyncTest();
  broadcastStatus();
  return true;
}

function invalidateMicTiming(message: string) {
  clearBootCalibrationState();
  if (calibration.collecting) calibration.fail(message);
  else calibration.reset();
  calibrationKind = 'none';
  lastAutoCalibrationAt = -Infinity;
  syncAppliedCalibration();
  broadcastJson(timingCalibrationStatusPayload());
  broadcastJson(sourceStatusPayload());
}

function clickSample(sampleIndex: number) {
  const beatSamples = Math.round((MIX_SAMPLE_RATE * 60) / TEST_BPM);
  const clickSamples = Math.round(MIX_SAMPLE_RATE * 0.055);
  const phase = sampleIndex % beatSamples;
  if (phase >= clickSamples) return 0;

  const beat = Math.floor(sampleIndex / beatSamples);
  const accent = beat % 4 === 0;
  const frequency = accent ? 1500 : 1000;
  const amplitude = accent ? 0.18 : 0.12;
  const seconds = phase / MIX_SAMPLE_RATE;
  const envelope = Math.exp(-seconds * 55);
  return Math.sin(2 * Math.PI * frequency * seconds) * amplitude * envelope;
}

function writeMixedSample(output: Buffer, index: number, value: number) {
  const mixed = Math.max(-1, Math.min(1, value));
  const intSample = mixed < 0 ? Math.round(mixed * 32768) : Math.round(mixed * 32767);
  output.writeInt16LE(intSample, index * 2);
}

function clickMixedFrame(frameIndex: number) {
  const startSample = frameIndex * MIX_FRAME_SAMPLES;
  const mic = session.readMic(startSample, MIX_FRAME_SAMPLES);
  const gain = 10 ** (micGainDb / 20);
  const output = Buffer.allocUnsafe(MIX_FRAME_SAMPLES * 2);

  for (let i = 0; i < MIX_FRAME_SAMPLES; i += 1) {
    const micValue = (mic[i] / 32768) * gain;
    writeMixedSample(output, i, micValue + clickSample(startSample + i));
  }

  const retentionSamples = Math.round((MIC_RETENTION_MS * MIX_SAMPLE_RATE) / 1000);
  session.trimMic(startSample - retentionSamples);
  return output;
}

function startSyncTest() {
  if (session.active) return false;
  testActive = true;
  testStartedAt = performance.now();
  testFrameIndex = 0;
  session.clearMic();
  broadcastJson(testStatusPayload());
  broadcastJson(mixSettingsPayload());
  return true;
}

function stopSyncTest() {
  if (!testActive) return;
  testActive = false;
  session.clearMic();
  broadcastJson(testStatusPayload());
  broadcastStatus();
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
  cancelBackingGrace();

  if (session.active) {
    refreshLiveMicNetworkCompensation();
    broadcastJson(sourceStatusPayload());
    broadcastJson(timingCalibrationStatusPayload());
    return;
  }

  if (testActive) stopSyncTest();
  session.start();
  refreshLiveMicNetworkCompensation();
  broadcastJson(sourceStatusPayload());
  broadcastJson(testStatusPayload());
  broadcastJson(mixSettingsPayload());
  broadcastJson(timingCalibrationStatusPayload());
}

function restartLiveSourceAfterMicReconnect() {
  if (!session.active || backing?.readyState !== WebSocket.OPEN) return;
  refreshLiveMicNetworkCompensation();
  if (calibration.collecting) {
    calibration.fail('Microphone reconnected during calibration. Start calibration again.');
  }
  broadcastJson(sourceStatusPayload());
  broadcastJson(testStatusPayload());
}

function abandonProbeRun() {
  pendingProbe = null;
  pendingProbeAnalysis = null;
  measuredMicLeg = null;
}

function clearBootCalibrationState() {
  abandonProbeRun();
  lastProbeContext = null;
  lastBootCalibration = null;
  bootPathDifferenceMs = null;
  bootConfidence = null;
  lastProbeCorrelation = { mic: null, backing: null };
}

function stopLiveSource() {
  cancelBackingGrace();
  if (!session.active) return;
  clearBootCalibrationState();
  robotPlayerOffsetMs = null;
  robotPlayerOffsetAt = -Infinity;
  session.stop();
  calibration.reset();
  calibrationKind = 'none';
  lastAutoCalibrationAt = -Infinity;
  broadcastJson(timingCalibrationStatusPayload());
  broadcastJson(sourceStatusPayload());
  broadcastJson(testStatusPayload());
  broadcastStatus();
}

const mixerTimer = setInterval(() => {
  if (testActive) {
    const elapsed = performance.now() - testStartedAt - TEST_PREBUFFER_MS;
    if (elapsed < 0) return;

    const expectedFrames = Math.floor(elapsed / MIX_FRAME_MS) + 1;
    let framesToSend = Math.min(5, expectedFrames - testFrameIndex);
    while (framesToSend > 0) {
      broadcastToMonitors(clickMixedFrame(testFrameIndex), true);
      testFrameIndex += 1;
      framesToSend -= 1;
    }
    return;
  }

  session.drain((frame) => broadcastToMonitors(frame, true));
}, 5);

function maybeAutoCalibrate(nowMs: number) {
  if (!AUTO_CALIBRATE) return;
  if (robotRouteActive()) return;
  if (!session.active || calibration.collecting) return;
  if (calibration.result !== null && !calibrationIsStale()) return;
  if (nowMs - lastAutoCalibrationAt < AUTO_CALIBRATION_RETRY_MS) return;

  if (backing?.readyState !== WebSocket.OPEN || publisher?.readyState !== WebSocket.OPEN) return;
  if (!bothStreamsFlowing(nowMs)) return;
  const timeline = currentTimelineStatus();
  if (!timeline.connected || Number(timeline.state) !== 1) return;

  lastAutoCalibrationAt = nowMs;
  calibrationWasAutomatic = true;
  calibrationKind = 'content';
  calibration.start(nowMs);
  broadcastJson(timingCalibrationStatusPayload());
}

function probeGeneration(target: ProbeTarget) {
  return target === 'mic' ? session.micGeneration : session.backingGeneration;
}

function probePathReady(target: ProbeTarget, nowMs: number) {
  if (target === 'mic') {
    return publisher?.readyState === WebSocket.OPEN && nowMs - lastMicFrameAt < STREAM_LIVE_MS;
  }
  return backing?.readyState === WebSocket.OPEN
    && nowMs - lastBackingFrameAt < STREAM_LIVE_MS
    && activeRobotSource?.readyState === WebSocket.OPEN;
}

function sendProbeRequest(target: ProbeTarget, nowMs: number) {
  lastProbeAttemptAt = nowMs;
  probeRequestId += 1;
  pendingProbe = {
    target,
    requestId: probeRequestId,
    serverSentAtMs: nowMs,
    generation: probeGeneration(target),
  };
  calibrationKind = 'boot-probe';
  if (PROBE_DEBUG) console.log(`[probe] ${pendingProbe.target} sent #${probeRequestId} generation=${probeGeneration(target)}`);

  const payload = { type: 'play-calibration-probe', target, requestId: probeRequestId, leadMs: PROBE_LEAD_MS };
  if (target === 'mic') {
    sendJson(publisher!, payload);
  } else if (activeRobotSource) {
    sendJson(activeRobotSource, payload);
  }
}

function maybeStartProbeCalibration(nowMs: number) {
  if (!PROBE_CALIBRATE || !robotRouteActive()) return;
  if (!session.active || calibration.collecting) return;

  if (
    measuredMicLeg !== null
    && (
      measuredMicLeg.sessionGeneration !== session.generation
      || measuredMicLeg.micGeneration !== session.micGeneration
    )
  ) {
    abandonProbeRun();
  }

  if (
    calibrationKind === 'boot-probe'
    && calibration.result !== null
    && !calibrationIsStale()
  ) return;
  if (pendingProbe !== null || pendingProbeAnalysis !== null) return;
  if (nowMs - lastProbeAttemptAt < PROBE_RETRY_MS) return;

  if (
    measuredMicLeg === null
    && lastProbeContext !== null
    && lastProbeContext.sessionGeneration === session.generation
    && lastProbeContext.micGeneration === session.micGeneration
    && lastProbeContext.backingGeneration === session.backingGeneration
  ) return;

  const target: ProbeTarget = measuredMicLeg === null ? 'mic' : 'backing';
  if (!probePathReady(target, nowMs)) return;
  sendProbeRequest(target, nowMs);
}

function handleProbeReply(reply: { requestId: unknown; generation: unknown }, nowMs: number) {
  const pending = pendingProbe;
  pendingProbe = null;
  if (!pending || Number(reply.requestId) !== pending.requestId) return;
  if (!session.active) return;

  const generationHeld = probeGeneration(pending.target) === pending.generation;
  const clientAgrees = pending.target === 'mic'
    ? (Number(reply.generation) >>> 0) === pending.generation
    : true;
  if (!generationHeld || !clientAgrees) {
    if (PROBE_DEBUG) console.log(`[probe] ${pending.target} dropped: generation mismatch`);
    abandonProbeRun();
    return;
  }

  const oneWayMs = (nowMs - pending.serverSentAtMs) / 2;
  const targetSample = Math.round(session.sessionSampleAt(pending.serverSentAtMs + oneWayMs + PROBE_LEAD_MS));
  const marginSamples = Math.round((MIX_SAMPLE_RATE * PROBE_SEARCH_MARGIN_MS) / 1000);
  const referenceSamples = Math.round((MIX_SAMPLE_RATE * PROBE_REFERENCE_MS) / 1000);

  pendingProbeAnalysis = {
    target: pending.target,
    targetSample,
    windowStart: targetSample - Math.round(marginSamples / 8),
    windowSamples: referenceSamples + marginSamples,
    generation: pending.generation,
    deadlineMs: nowMs + PROBE_ANALYSIS_TIMEOUT_MS,
  };
}

function maybeFinishProbeAnalysis(nowMs: number) {
  const waiting = pendingProbeAnalysis;
  if (!waiting) return;

  const reached = waiting.target === 'mic' ? session.micTotalSamples : session.backingTotalSamples;
  const needed = waiting.windowStart + waiting.windowSamples;

  if (!session.active || probeGeneration(waiting.target) !== waiting.generation || nowMs > waiting.deadlineMs) {
    if (PROBE_DEBUG) {
      console.log(
        `[probe] ${waiting.target} analysis dropped: active=${session.active}`
        + ` generation=${probeGeneration(waiting.target)}/${waiting.generation}`
        + ` timedOut=${nowMs > waiting.deadlineMs} reached=${reached} needed=${needed}`,
      );
    }
    abandonProbeRun();
    return;
  }

  if (reached < needed) return;
  pendingProbeAnalysis = null;

  const window = waiting.target === 'mic'
    ? session.readMic(waiting.windowStart, waiting.windowSamples)
    : session.readBacking(waiting.windowStart, waiting.windowSamples);
  const { offsetSamples, correlation } = locateProbe(window, MIX_SAMPLE_RATE);
  const actualSample = waiting.windowStart + offsetSamples;
  const latencyMs = ((actualSample - waiting.targetSample) / MIX_SAMPLE_RATE) * 1000;
  lastProbeCorrelation = { ...lastProbeCorrelation, [waiting.target]: correlation };

  if (PROBE_DEBUG) {
    // The window's own peak separates "the probe was not heard" from "the
    // probe was never looked at": a correlation of -1 is what an all-zero
    // window scores, and a range the timeline does not cover reads as zeros.
    let peak = 0;
    for (let i = 0; i < window.length; i += 1) {
      const magnitude = Math.abs(window[i]);
      if (magnitude > peak) peak = magnitude;
    }
    // And the most recent audio on the same timeline, as a control: if that is
    // silent too the stream is not carrying anything, and if it is not the
    // window is simply looking in the wrong place.
    const controlSeconds = 20;
    const recent = waiting.target === 'mic'
      ? session.readMic(reached - MIX_SAMPLE_RATE * controlSeconds, MIX_SAMPLE_RATE * controlSeconds)
      : session.readBacking(reached - MIX_SAMPLE_RATE * controlSeconds, MIX_SAMPLE_RATE * controlSeconds);
    let recentPeak = 0;
    for (let i = 0; i < recent.length; i += 1) {
      const magnitude = Math.abs(recent[i]);
      if (magnitude > recentPeak) recentPeak = magnitude;
    }
    console.log(
      `[probe] ${waiting.target} correlation=${correlation.toFixed(3)} latencyMs=${latencyMs.toFixed(0)}`
      + ` windowPeak=${peak} recent${controlSeconds}sPeak=${recentPeak}`
      + ` windowStart=${waiting.windowStart} needed=${needed} reached=${reached}`,
    );
  }

  if (correlation < PROBE_MIN_CORRELATION) {
    abandonProbeRun();
    broadcastJson(timingCalibrationStatusPayload());
    return;
  }

  const leg = { targetSample: waiting.targetSample, actualSample, correlation };

  if (waiting.target === 'mic') {
    measuredMicLeg = {
      ...leg,
      sessionGeneration: session.generation,
      micGeneration: waiting.generation,
    };
    broadcastJson(timingCalibrationStatusPayload());
    return;
  }

  const micLeg = measuredMicLeg;
  measuredMicLeg = null;
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

  lastProbeContext = {
    sessionGeneration: session.generation,
    micGeneration: session.micGeneration,
    backingGeneration: session.backingGeneration,
  };
  lastBootCalibration = result;
  bootPathDifferenceMs = result.micLatencyMs - result.backingLatencyMs;
  bootConfidence = result.confidence;
  calibrationKind = 'boot-probe';
  calibration.applyExternalResult({
    micLagMs: result.advanceMs,
    confidence: Math.max(0, Math.min(1, result.confidence)),
  });
}

function currentDeltaMs(nowMs: number) {
  return robotDeltaIsFresh(nowMs) ? robotPlayerOffsetMs! : 0;
}

function maybeReapplyBootCalibration(nowMs: number) {
  if (!robotRouteActive() || calibrationKind !== 'boot-probe') return;
  if (bootPathDifferenceMs === null || calibration.collecting) return;
  if (!robotDeltaIsFresh(nowMs)) return;
  if (lastProbeContext === null) return;
  if (
    lastProbeContext.sessionGeneration !== session.generation
    || lastProbeContext.micGeneration !== session.micGeneration
    || lastProbeContext.backingGeneration !== session.backingGeneration
  ) return;

  const advanceMs = bootPathDifferenceMs + currentDeltaMs(nowMs);
  const applied = session.alignment.calibratedMicLagMs;
  if (applied !== null && Math.abs(advanceMs - applied) < BOOT_DELTA_REAPPLY_MS) return;

  if (PROBE_DEBUG) {
    console.log(`[probe] delta moved; advanceMs ${applied?.toFixed(0) ?? 'none'} -> ${advanceMs.toFixed(0)}`);
  }
  lastBootCalibration = lastBootCalibration === null ? null : {
    ...lastBootCalibration,
    advanceMs,
    deltaMs: currentDeltaMs(nowMs),
  };
  calibrationKind = 'boot-probe';
  calibration.applyExternalResult({ micLagMs: advanceMs, confidence: bootConfidence ?? 0 });
}

function dropLegacyCalibrationForRobot() {
  if (!robotRouteActive() || calibrationKind !== 'content') return;
  calibration.reset();
  calibrationKind = 'none';
  lastAutoCalibrationAt = -Infinity;
  syncAppliedCalibration();
}

function restartBootCalibration(nowMs: number, automatic: boolean) {
  calibration.reset();
  calibrationKind = 'boot-probe';
  calibrationWasAutomatic = automatic;
  clearBootCalibrationState();
  robotPlayerOffsetMs = null;
  robotPlayerOffsetAt = -Infinity;
  lastProbeAttemptAt = -Infinity;
  syncAppliedCalibration();
  maybeStartProbeCalibration(nowMs);
  broadcastJson(timingCalibrationStatusPayload());
  broadcastJson(sourceStatusPayload());
}

const youtubeTimelineTimer = setInterval(() => {
  const nowMs = performance.now();

  if (youtubeTimeline.hasTelemetry) {
    broadcastJson(youtubeTimeline.statusPayload(nowMs));
    broadcastJson(youtubeTimeline.roomStatusPayload(nowMs));
  }

  if (roomSongCommands.sweep(nowMs)) {
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

  if (pendingProbe !== null && nowMs - pendingProbe.serverSentAtMs > PROBE_REPLY_TIMEOUT_MS) {
    pendingProbe = null;
  }

  dropLegacyCalibrationForRobot();
  // Freshness is a live validity condition, not just something checked when a
  // socket closes. If a robot page freezes while its WebSocket remains open,
  // the last delta loses authority after ROBOT_OFFSET_FRESH_MS as well.
  if (syncAppliedCalibration()) {
    broadcastJson(sourceStatusPayload());
    broadcastJson(timingCalibrationStatusPayload());
  }
  maybeFinishProbeAnalysis(nowMs);
  maybeStartProbeCalibration(nowMs);
  maybeReapplyBootCalibration(nowMs);
  maybeAutoCalibrate(nowMs);

  sweepPreparedSongHandoff(nowMs);

  const presenceSweep = participants.sweep(Date.now());
  if (presenceSweep.releasedMicOwnerId) {
    cancelMicTransportGrace();
    if (youtubeTimeline.cancelHandoff()) broadcastJson(youtubeTimeline.roomStatusPayload(nowMs));
    invalidateMicTiming('Microphone owner left the Relay session.');
  }
  if (presenceSweep.changed) broadcastSessionStatus();
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

wss.on('connection', (rawSocket, request) => {
  const socket = rawSocket as RelaySocket;
  socket.role = 'unknown';
  socket.isAlive = true;
  legacyPlaybackConnectionSequence += 1;
  socket.legacyPlaybackGeneration = legacyPlaybackConnectionSequence;

  const identity = participantIdentity(request);
  if (identity) {
    participantConnectionSequence += 1;
    socket.participantId = identity.participantId;
    socket.participantConnectionId = `connection-${participantConnectionSequence}`;
    const changed = participants.attach({
      connectionId: socket.participantConnectionId,
      participantId: identity.participantId,
      nickname: identity.nickname,
      nowMs: Date.now(),
    });
    if (changed) broadcastSessionStatus();
    else sendJson(socket, sessionStatusPayload());
  }

  socket.on('pong', () => {
    socket.isAlive = true;
  });

  socket.on('message', (data, isBinary) => {
    socket.isAlive = true;

    if (isBinary) {
      const frame = decodePcmFrame(data as Buffer);

      if (socket === publisher && socket.role === 'publisher') {
        if (testActive || session.active) {
          const previousGeneration = session.micGeneration;
          lastMicFrameAt = performance.now();
          const { samples, start } = session.ingestMic(frame, publisherSampleRate);

          if (session.active) {
            const micRestarted = previousGeneration !== null && session.micGeneration !== previousGeneration;
            if (micRestarted) {
              abandonProbeRun();
              if (calibration.collecting) {
                calibration.fail('Microphone capture restarted during calibration. Start calibration again.');
              } else {
                syncAppliedCalibration();
                broadcastJson(sourceStatusPayload());
                broadcastJson(timingCalibrationStatusPayload());
              }
            }
            calibration.observeMic(samples, start);
          }
        } else {
          broadcastToMonitors(frame.pcm, true);
        }
        return;
      }

      if (socket === backing && socket.role === 'backing' && session.active) {
        const previousGeneration = session.backingGeneration;
        lastBackingFrameAt = performance.now();
        const { samples, start } = session.ingestBacking(frame, backingSampleRate);
        if (
          previousGeneration !== null
          && session.backingGeneration !== previousGeneration
        ) {
          abandonProbeRun();
          if (calibration.collecting) {
            calibration.fail('Backing capture restarted during calibration. Start calibration again.');
          } else {
            syncAppliedCalibration();
            broadcastJson(sourceStatusPayload());
            broadcastJson(timingCalibrationStatusPayload());
          }
        }
        calibration.observeBacking(samples, start);
      }
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

    if (payload.type === 'clock-ping') {
      const serverReceivedAtMs = Date.now();
      sendJson(socket, {
        type: 'clock-pong',
        id: payload.id,
        clientSentAtMs: payload.clientSentAtMs,
        serverReceivedAtMs,
        serverSentAtMs: Date.now(),
      });
      return;
    }

    if (payload.type === 'session-status-request') {
      sendJson(socket, sessionStatusPayload());
      return;
    }

    if (payload.type === 'participant-rename') {
      if (!socket.participantId) return;
      if (participants.rename(socket.participantId, payload.nickname, Date.now())) {
        broadcastSessionStatus();
      } else {
        sendJson(socket, sessionStatusPayload());
      }
      return;
    }

    if (payload.type === 'acquire-mic' || payload.type === 'force-acquire-mic') {
      sendJson(socket, {
        type: 'error',
        message: 'Microphone ownership is committed by publisher registration, not reserved separately.',
      });
      return;
    }

    if (payload.type === 'release-mic') {
      if (!socket.participantId) return;
      const result = participants.releaseMic(socket.participantId);
      if (!result.ok) return;

      cancelMicTransportGrace();
      if (youtubeTimeline.cancelHandoff()) {
        broadcastJson(youtubeTimeline.statusPayload());
        broadcastJson(youtubeTimeline.roomStatusPayload());
      }
      if (publisher?.participantId === socket.participantId) {
        revokePublisherTransport('You released the microphone.');
      }
      invalidateMicTiming('Microphone was released.');
      broadcastSessionStatus();
      sendJson(socket, { type: 'mic-released' });
      return;
    }

    if (payload.type === 'playback-hello') {
      if (!socket.participantId) return;
      const transportId = normalizePlaybackTransportId(payload.playbackTransportId);
      const generation = normalizePlaybackGeneration(payload.playbackGeneration);
      if (!transportId || generation === null) {
        sendJson(socket, { type: 'error', message: 'Invalid playback transport identity.' });
        return;
      }

      socket.playbackParticipantId = socket.participantId;
      socket.playbackTransportId = transportId;
      socket.playbackGeneration = generation;
      sendJson(socket, { type: 'playback-registered', playbackTransportId: transportId, playbackGeneration: generation });
      sendJson(socket, youtubeTimeline.roomStatusPayload());
      sendJson(socket, roomSongCommandStatusPayload());

      const playbackIdentity = playbackIdentityForSocket(socket);
      const pendingPlan = playbackIdentity
        ? youtubeTimeline.handoffPlanForTarget(playbackIdentity)
        : null;
      if (pendingPlan) sendHandoffPlan('song-handoff-prepare', pendingPlan);

      const pendingCommand = playbackIdentity
        ? roomSongCommands.pendingForTarget(playbackIdentity, performance.now())
        : null;
      if (pendingCommand) sendToPlayback(playbackIdentity!, roomSongCommandApplyPayload(pendingCommand));
      return;
    }

    if (payload.type === 'playback-mic-intent') {
      const playbackIdentity = playbackIdentityForSocket(socket);
      if (!playbackIdentity || playbackIdentity.participantId !== socket.participantId) return;
      socket.playbackMicIntentAtMs = performance.now();
      sendJson(socket, { type: 'playback-mic-intent-registered' });
      return;
    }

    if (payload.type === 'room-song-status-request') {
      sendJson(socket, youtubeTimeline.roomStatusPayload());
      return;
    }

    if (payload.type === 'room-song-command-status-request') {
      sendJson(socket, roomSongCommandStatusPayload());
      return;
    }

    if (payload.type === 'room-song-command') {
      if (!socket.participantId) {
        rejectRoomSongCommand(socket, payload.commandId, 'participant-required');
        return;
      }

      const playbackIdentity = playbackIdentityForSocket(socket);
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
        roomSongCommandRevision,
        roomSongCommandRevision + 1,
        nowMs,
      );
      if (!decision.ok) {
        rejectRoomSongCommand(socket, parsed.request.commandId, decision.reason);
        return;
      }

      if (!decision.duplicate) roomSongCommandRevision = decision.command.revision;
      sendJson(socket, {
        type: 'room-song-command-accepted',
        commandId: decision.command.commandId,
        revision: decision.command.revision,
        duplicate: decision.duplicate,
      });

      const stillPending = roomSongCommands.pendingForTarget(playbackIdentity, nowMs);
      if (stillPending?.commandId === decision.command.commandId) {
        sendToPlayback(playbackIdentity, roomSongCommandApplyPayload(decision.command));
      }
      broadcastJson(roomSongCommandStatusPayload(nowMs));
      return;
    }

    if (payload.type === 'room-song-command-failed') {
      const playbackIdentity = playbackIdentityForSocket(socket);
      if (!playbackIdentity) return;
      if (roomSongCommands.fail(playbackIdentity, payload.commandId)) {
        sendJson(socket, {
          type: 'room-song-command-failed-ack',
          commandId: payload.commandId,
          revision: roomSongCommandRevision,
        });
        broadcastJson(roomSongCommandStatusPayload());
      }
      return;
    }

    if (payload.type === 'song-handoff-ready') {
      const playbackIdentity = playbackIdentityForSocket(socket);
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
      return;
    }

    if (payload.type === 'song-handoff-failed') {
      const playbackIdentity = playbackIdentityForSocket(socket);
      if (!playbackIdentity) return;
      if (youtubeTimeline.deferHandoff(playbackIdentity, payload.handoffId)) {
        broadcastJson(youtubeTimeline.statusPayload());
        broadcastJson(youtubeTimeline.roomStatusPayload());
      }
      return;
    }

    if (payload.type === 'youtube-telemetry') {
      let playbackParticipantId = socket.participantId;
      let playbackTransportId = socket.playbackTransportId
        ?? normalizePlaybackTransportId(payload.playbackTransportId);
      let playbackGeneration = socket.playbackGeneration
        ?? normalizePlaybackGeneration(payload.playbackGeneration);

      if (!playbackParticipantId) {
        // Compatibility for pre-participant publisher clients. The authority is
        // the current server-selected publisher transport, never an identity
        // claimed by the telemetry payload. Anonymous monitor/backing/unknown
        // sockets therefore remain unable to mutate the room clock.
        if (socket !== publisher || socket.role !== 'publisher') {
          reportTelemetryRejected(socket, 'not-publisher');
          return;
        }
        playbackParticipantId = LEGACY_PLAYBACK_PARTICIPANT_ID;
        // One logical legacy transport whose incarnation counts up, not a new
        // transport per socket. A replacement publisher is the same anonymous
        // playback device reconnecting, so it must be able to take the room
        // clock through the normal newer-generation rule instead of waiting out
        // the previous socket's staleness window.
        playbackTransportId = LEGACY_PLAYBACK_TRANSPORT_ID;
        playbackGeneration = socket.legacyPlaybackGeneration ?? 0;
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
        sendJson(socket, {
          type: 'room-song-telemetry-rejected',
          reason: commandGate.reason,
          revision: roomSongCommandRevision,
        });
        return;
      }

      const result = youtubeTimeline.update(
        payload,
        acceptedIdentity,
        participants.micOwnerId,
        nowMs,
      );
      if (result.accepted) {
        socket.playbackParticipantId = playbackParticipantId;
        socket.playbackTransportId = playbackTransportId;
        socket.playbackGeneration = playbackGeneration;
        socket.telemetryRejectedReason = undefined;
        const timelineStatus = youtubeTimeline.statusPayload(nowMs);
        broadcastJson(timelineStatus);
        broadcastJson(youtubeTimeline.roomStatusPayload(nowMs));

        if (
          commandGate.completesCommandId
          && roomSongCommands.complete(commandGate.completesCommandId)
        ) {
          sendToPlayback(acceptedIdentity, {
            type: 'room-song-command-complete',
            commandId: commandGate.completesCommandId,
            revision: roomSongCommandRevision,
          });
          broadcastJson(roomSongCommandStatusPayload(nowMs));
        }

        if (result.handoffCompleted && result.handoffId) {
          if (result.previousLeader) {
            sendToPlayback(result.previousLeader, {
              type: 'song-handoff-release',
              handoffId: result.handoffId,
              videoId: timelineStatus.videoId ?? null,
            });
          }
          sendToPlayback(acceptedIdentity, {
            type: 'song-handoff-complete',
            handoffId: result.handoffId,
          });
        }
      } else {
        reportTelemetryRejected(socket, result.reason ?? 'invalid-telemetry');
      }
      return;
    }

    if (payload.type === 'youtube-timeline-request') {
      sendJson(socket, youtubeTimeline.statusPayload());
      return;
    }

    if (payload.type === 'source-status-request') {
      sendJson(socket, sourceStatusPayload());
      return;
    }

    if (payload.type === 'timing-calibration-status-request') {
      sendJson(socket, timingCalibrationStatusPayload());
      return;
    }

    if (payload.type === 'start-timing-calibration') {
      if (!requireMicOwnerCommand(socket, 'start-timing-calibration')) return;
      const nowMs = performance.now();
      if (
        !session.active
        || backing?.readyState !== WebSocket.OPEN
        || publisher?.readyState !== WebSocket.OPEN
      ) {
        calibration.fail('Connect both phone Microphone and Desktop Source before calibration.');
        return;
      }

      const silent = silentSides(nowMs);
      if (silent.length > 0) {
        calibration.fail(
          `No audio arriving from the ${silent.join(' or ')}. `
          + 'Restart the backing source: on a development desktop the source page was probably reloaded, which drops the tab capture.',
        );
        return;
      }

      if (robotRouteActive()) {
        restartBootCalibration(nowMs, false);
        return;
      }

      const timeline = currentTimelineStatus(nowMs);
      if (!timeline.connected || Number(timeline.state) !== 1) {
        calibration.fail('Play YouTube on the phone before calibration.');
        return;
      }
      calibrationWasAutomatic = false;
      calibrationKind = 'content';
      calibration.start(nowMs);
      broadcastJson(timingCalibrationStatusPayload());
      return;
    }

    if (payload.type === 'source-seeked') {
      sourceGeneration += 1;
      robotPlayerOffsetMs = null;
      robotPlayerOffsetAt = -Infinity;
      if (calibration.collecting) {
        calibration.fail('The desktop player seeked during calibration. Start calibration again.');
      } else {
        syncAppliedCalibration();
        broadcastJson(sourceStatusPayload());
        broadcastJson(timingCalibrationStatusPayload());
      }
      return;
    }

    if (payload.type === 'set-vocal-fine-tune') {
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
    }

    if (payload.type === 'register' && payload.role === 'publisher') {
      const sampleRate = validSampleRate(payload.sampleRate);
      if (!sampleRate) {
        sendJson(socket, { type: 'error', message: 'Invalid sample rate.' });
        return;
      }

      const captureGeneration = validCaptureGeneration(payload.captureGeneration);
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

      let ownershipChanged = false;
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
        ownershipChanged = ownership.changed;
        previousOwnerId = ownership.previousOwnerId;
      } else if (participants.micOwnerId !== null) {
        sendJson(socket, { type: 'error', message: 'Microphone is owned by an active Relay participant.' });
        return;
      }

      const previousPublisher = publisher;
      const sameParticipantReplacement = Boolean(
        previousPublisher
        && previousPublisher !== socket
        && previousPublisher.participantId
        && previousPublisher.participantId === socket.participantId,
      );
      const sameCapture = Boolean(
        sameParticipantReplacement
        && previousPublisher?.captureGeneration !== undefined
        && captureGeneration !== null
        && previousPublisher.captureGeneration === captureGeneration,
      );

      if (previousPublisher && previousPublisher !== socket) {
        const newOwnerName = socket.participantId
          ? participantPayload(socket.participantId)?.nickname ?? 'Another participant'
          : 'Another microphone';
        retirePublisherTransport(
          previousPublisher,
          sameParticipantReplacement ? 'publisher-superseded' : 'mic-revoked',
          sameParticipantReplacement
            ? 'A newer microphone capture from this participant became active.'
            : `${newOwnerName} took over the microphone.`,
        );
      }

      socket.role = 'publisher';
      socket.sampleRate = sampleRate;
      socket.captureGeneration = captureGeneration ?? undefined;
      publisher = socket;
      publisherSampleRate = sampleRate;
      cancelMicTransportGrace();
      session.setMicExpected(true);

      if (ownershipChanged || (sameParticipantReplacement && !sameCapture)) {
        invalidateMicTiming(
          ownershipChanged
            ? 'Microphone ownership changed.'
            : 'Microphone capture changed.',
        );
      }

      restartLiveSourceAfterMicReconnect();
      sendJson(socket, {
        type: 'registered',
        role: 'publisher',
        takeover: hasTakeoverExpectation && previousOwnerId !== socket.participantId,
      });
      sendJson(socket, testStatusPayload());
      sendJson(socket, mixSettingsPayload());
      sendJson(socket, youtubeTimeline.statusPayload());
      sendJson(socket, youtubeTimeline.roomStatusPayload());
      sendJson(socket, roomSongCommandStatusPayload());
      sendJson(socket, sourceStatusPayload());
      sendJson(socket, timingCalibrationStatusPayload());
      broadcastStatus();
      if (socket.participantId) {
        broadcastSessionStatus();
        if (ownershipChanged) beginPreparedSongHandoff(socket.participantId);
      }
      return;
    }

    if (payload.type === 'register' && payload.role === 'backing') {
      const sampleRate = validSampleRate(payload.sampleRate);
      if (!sampleRate) {
        sendJson(socket, { type: 'error', message: 'Invalid backing sample rate.' });
        return;
      }

      replacePrevious(backing, socket, 'Replaced by a newer tab capture.');
      socket.role = 'backing';
      socket.sampleRate = sampleRate;
      backing = socket;
      backingSampleRate = sampleRate;
      backingIsRobot = payload.robot === true;
      session.setBackingExpected(true);

      dropLegacyCalibrationForRobot();
      sendJson(socket, { type: 'registered', role: 'backing', robot: backingIsRobot });
      startLiveSource();
      return;
    }

    if (payload.type === 'register' && payload.role === 'monitor') {
      socket.role = 'monitor';
      sendJson(socket, { type: 'registered', role: 'monitor' });
      sendJson(socket, publisherStatusPayload());
      sendJson(socket, sourceStatusPayload());
      sendJson(socket, timingCalibrationStatusPayload());
      sendJson(socket, testStatusPayload());
      sendJson(socket, mixSettingsPayload());
      sendJson(socket, youtubeTimeline.statusPayload());
      sendJson(socket, youtubeTimeline.roomStatusPayload());
      sendJson(socket, roomSongCommandStatusPayload());
      if (socket.participantId) sendJson(socket, sessionStatusPayload());
      return;
    }

    if (payload.type === 'calibration-probe-played') {
      const fromPublisher = socket === publisher && socket.role === 'publisher';
      const target = payload.target === 'backing' ? 'backing' : 'mic';
      const fromActiveRobot = socket === activeRobotSource && socket.isRobotSource === true;
      if (target === 'mic' ? fromPublisher : fromActiveRobot) {
        handleProbeReply({ requestId: payload.requestId, generation: payload.generation }, performance.now());
      }
      return;
    }

    if (payload.type === 'robot-source-hello') {
      if (activeRobotSource === socket) return;

      const previous = activeRobotSource;
      if (previous && previous !== socket) {
        previous.isRobotSource = false;
        sendJson(previous, { type: 'robot-source-replaced' });
        sourceGeneration += 1;
      }

      activeRobotSource = socket;
      socket.isRobotSource = true;
      robotPlayerOffsetMs = null;
      robotPlayerOffsetAt = -Infinity;
      dropLegacyCalibrationForRobot();
      syncAppliedCalibration();
      broadcastJson(sourceStatusPayload());
      broadcastJson(timingCalibrationStatusPayload());
      return;
    }

    if (payload.type === 'robot-player-offset') {
      const offsetMs = Number(payload.offsetMs);
      if (socket === activeRobotSource && socket.isRobotSource === true && Number.isFinite(offsetMs)) {
        robotPlayerOffsetMs = offsetMs;
        robotPlayerOffsetAt = performance.now();
      }
      return;
    }

    if (payload.type === 'start-sync-test') {
      // Same authority as stopping it. Requiring the physical publisher socket
      // here while `stop-sync-test` accepts any transport of the Mic owner made
      // one feature answer to two different boundaries, so the owner's second
      // tab could stop a test it was not allowed to start.
      if (!requireMicOwnerCommand(socket, 'start-sync-test')) return;
      if (!startSyncTest()) {
        sendJson(socket, { type: 'error', message: 'Captured tab source is active.' });
      }
      return;
    }

    if (payload.type === 'stop-sync-test') {
      if (!requireMicOwnerCommand(socket, 'stop-sync-test')) return;
      stopSyncTest();
      return;
    }

    if (payload.type === 'set-mix') {
      if (!requireMicOwnerCommand(socket, 'set-mix')) return;
      const nextGain = Number(payload.micGainDb);
      if (Number.isFinite(nextGain)) {
        micGainDb = Math.max(0, Math.min(36, nextGain));
        session.setMicGainDb(micGainDb);
      }
      const nextSongLevel = Number(payload.songLevel);
      if (Number.isFinite(nextSongLevel)) {
        songLevel = Math.max(0, Math.min(100, Math.round(nextSongLevel)));
      }
      broadcastJson(mixSettingsPayload());
      return;
    }
  });

  socket.on('close', () => {
    let micTransportChanged = false;

    const closingPlaybackIdentity = playbackIdentityForSocket(socket);
    if (closingPlaybackIdentity) {
      const pendingCommand = roomSongCommands.pendingForTarget(closingPlaybackIdentity, performance.now());
      if (
        pendingCommand
        && roomSongCommands.fail(closingPlaybackIdentity, pendingCommand.commandId)
      ) {
        broadcastJson(roomSongCommandStatusPayload());
      }
    }

    if (
      socket.playbackParticipantId
      && socket.playbackTransportId
      && socket.playbackGeneration !== undefined
    ) {
      const playbackChanged = youtubeTimeline.detach({
        participantId: socket.playbackParticipantId,
        transportId: socket.playbackTransportId,
        generation: socket.playbackGeneration,
      });
      if (playbackChanged) {
        broadcastJson(youtubeTimeline.statusPayload());
        broadcastJson(youtubeTimeline.roomStatusPayload());
      }
    }

    if (!socket.replaced) {
      if (socket === activeRobotSource) {
        activeRobotSource = null;
        socket.isRobotSource = false;
        robotPlayerOffsetMs = null;
        robotPlayerOffsetAt = -Infinity;
        sourceGeneration += 1;
        syncAppliedCalibration();
        broadcastJson(sourceStatusPayload());
        broadcastJson(timingCalibrationStatusPayload());
      }

      if (socket === publisher) {
        const reconnectingOwnerId = socket.participantId
          && participants.micOwnerId === socket.participantId
          ? socket.participantId
          : null;
        publisher = null;
        publisherSampleRate = null;
        session.setMicExpected(false);
        micTransportChanged = true;
        if (reconnectingOwnerId) scheduleMicTransportGrace(reconnectingOwnerId);
        if (calibration.collecting) {
          calibration.fail('Microphone disconnected during calibration.');
        }
        if (testActive) stopSyncTest();
        broadcastStatus();
      }

      if (socket === backing) {
        backing = null;
        backingSampleRate = null;
        backingIsRobot = false;
        session.setBackingExpected(false);
        if (calibration.collecting) {
          calibration.fail('Desktop Source disconnected during calibration.');
        }
        cancelBackingGrace();
        backingAbsenceTimer = setTimeout(stopLiveSource, BACKING_GRACE_MS);
        broadcastJson(sourceStatusPayload());
        broadcastStatus();
      }
    }

    const presenceChanged = socket.participantConnectionId
      ? participants.detach(socket.participantConnectionId, Date.now())
      : false;
    if (presenceChanged || micTransportChanged) broadcastSessionStatus();
  });
});

const heartbeat = setInterval(() => {
  for (const client of wss.clients) {
    const socket = client as RelaySocket;
    if (!socket.isAlive) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, HEARTBEAT_MS);

wss.on('close', () => {
  cancelMicTransportGrace();
  clearInterval(heartbeat);
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

server.listen(port, '0.0.0.0', () => {
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  console.log(`Relay listening on http://localhost:${actualPort}`);
  console.log('For a phone, expose this HTTP server through an HTTPS tunnel before using the microphone.');
});
