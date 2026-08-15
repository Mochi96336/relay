import { createServer } from 'node:http';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import express from 'express';
import WebSocket, { WebSocketServer } from 'ws';

import { AudioSession, LIMITER_THRESHOLD_DBFS } from './audio-session.js';
import { combineBootCalibration, type BootCalibrationResult } from './boot-calibration.js';
import { locateProbe, PROBE_REFERENCE_MS } from './calibration-probe.js';
import { CalibrationSession, type CalibrationContext } from './calibration-session.js';
import { decodePcmFrame } from './pcm-frame.js';
import { YouTubeTimelineTracker } from './youtube-timeline.js';

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
const TIMING_CALIBRATION_MS = 6_000;
const TIMING_CALIBRATION_TIMEOUT_MS = envMs('RELAY_CALIBRATION_TIMEOUT_MS', 20_000);
const MAX_VOCAL_FINE_TUNE_MS = 100;
const HEARTBEAT_MS = envMs('RELAY_HEARTBEAT_MS', 8_000);
const MIX_HEALTH_INTERVAL_MS = 1_000;

const app = express();
app.disable('x-powered-by');
app.use(express.static(publicDir));
app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
const youtubeTimeline = new YouTubeTimelineTracker();

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
  isAlive: boolean;
  replaced?: boolean;
  isRobotSource?: boolean;
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

const session = new AudioSession({
  sampleRate: MIX_SAMPLE_RATE,
  frameMs: MIX_FRAME_MS,
  prebufferMs: LIVE_MIX_PREBUFFER_MS,
  backingGain: LIVE_BACKING_GAIN,
  retentionMs: MIC_RETENTION_MS,
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
const PROBE_SEARCH_MARGIN_MS = envMs('RELAY_CALIBRATION_PROBE_SEARCH_MARGIN_MS', 3_000);
const PROBE_MIN_CORRELATION = Number(process.env.RELAY_CALIBRATION_PROBE_MIN_CORRELATION ?? 0.5);
const PROBE_DEBUG = process.env.RELAY_CALIBRATION_PROBE_DEBUG === '1';
const PROBE_REPLY_TIMEOUT_MS = 3_000;
const PROBE_ANALYSIS_TIMEOUT_MS = envMs('RELAY_CALIBRATION_PROBE_ANALYSIS_TIMEOUT_MS', 8_000);

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
  return true;
}

function syncAppliedCalibration() {
  const nextMicLagMs = calibrationCanApply() ? calibration.result!.micLagMs : null;
  if (session.alignment.calibratedMicLagMs !== nextMicLagMs) {
    session.setAlignment({ calibratedMicLagMs: nextMicLagMs });
  }
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
  return {
    type: 'timing-calibration-status',
    ...status,
    activeMicLagMs: alignment.calibratedMicLagMs,
    timingMode: alignment.calibratedMicLagMs === null ? 'network-estimate' : 'acoustic-calibration',
    calibrationStale: calibrationIsStale(),
    calibrationKind,
    robotRoute: robotRouteActive(),
    robotSourceConnected: activeRobotSource?.readyState === WebSocket.OPEN,
    fallbackNetworkMs: alignment.networkCompensationMs,
    vocalFineTuneMs: alignment.fineTuneMs,
    appliedMicAdvanceMs: session.appliedMicAdvanceMs,
    requestedMicAdvanceMs: session.requestedMicAdvanceMs,
    probeCorrelation: lastProbeCorrelation,
    bootCalibration: lastBootCalibration,
    robotPlayerOffsetMs: performance.now() - robotPlayerOffsetAt <= ROBOT_OFFSET_FRESH_MS
      ? robotPlayerOffsetMs
      : null,
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
  if (PROBE_DEBUG) console.log(`[probe] ${target} sent #${probeRequestId} generation=${probeGeneration(target)}`);

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
    console.log(`[probe] ${waiting.target} correlation=${correlation.toFixed(3)} latencyMs=${latencyMs.toFixed(0)}`);
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
  if (robotPlayerOffsetMs === null) return 0;
  return nowMs - robotPlayerOffsetAt <= ROBOT_OFFSET_FRESH_MS ? robotPlayerOffsetMs : 0;
}

function maybeReapplyBootCalibration(nowMs: number) {
  if (!robotRouteActive() || calibrationKind !== 'boot-probe') return;
  if (bootPathDifferenceMs === null || calibration.collecting) return;
  if (nowMs - robotPlayerOffsetAt > ROBOT_OFFSET_FRESH_MS) return;
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
  maybeFinishProbeAnalysis(nowMs);
  maybeStartProbeCalibration(nowMs);
  maybeReapplyBootCalibration(nowMs);
  maybeAutoCalibrate(nowMs);
}, 250);

function validSampleRate(value: unknown) {
  const sampleRate = Number(value);
  return Number.isFinite(sampleRate) && sampleRate >= 8_000 && sampleRate <= 192_000
    ? sampleRate
    : null;
}

wss.on('connection', (rawSocket) => {
  const socket = rawSocket as RelaySocket;
  socket.role = 'unknown';
  socket.isAlive = true;

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

    if (payload.type === 'youtube-telemetry') {
      if (youtubeTimeline.update(payload)) {
        broadcastJson(youtubeTimeline.statusPayload());
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

      replacePrevious(publisher, socket, 'Replaced by a newer microphone connection.');
      socket.role = 'publisher';
      socket.sampleRate = sampleRate;
      publisher = socket;
      publisherSampleRate = sampleRate;
      session.setMicExpected(true);
      restartLiveSourceAfterMicReconnect();
      sendJson(socket, { type: 'registered', role: 'publisher' });
      sendJson(socket, testStatusPayload());
      sendJson(socket, mixSettingsPayload());
      sendJson(socket, youtubeTimeline.statusPayload());
      sendJson(socket, sourceStatusPayload());
      sendJson(socket, timingCalibrationStatusPayload());
      broadcastStatus();
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
      if (socket !== publisher || socket.role !== 'publisher') {
        sendJson(socket, { type: 'error', message: 'Only the microphone device can start the sync test.' });
        return;
      }
      if (!startSyncTest()) {
        sendJson(socket, { type: 'error', message: 'Captured tab source is active.' });
      }
      return;
    }

    if (payload.type === 'stop-sync-test') {
      stopSyncTest();
      return;
    }

    if (payload.type === 'set-mix') {
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
    }
  });

  socket.on('close', () => {
    if (socket.replaced) return;

    if (socket === activeRobotSource) {
      activeRobotSource = null;
      socket.isRobotSource = false;
      robotPlayerOffsetMs = null;
      robotPlayerOffsetAt = -Infinity;
      // A websocket outage may leave the browser/player itself alive, but until
      // that same page reconnects and publishes a fresh delta the old total is
      // not valid timing evidence. Invalidate only the source term: the measured
      // mic/backing path legs remain reusable and are folded back in on the next
      // fresh robot-player-offset.
      sourceGeneration += 1;
      syncAppliedCalibration();
      broadcastJson(sourceStatusPayload());
      broadcastJson(timingCalibrationStatusPayload());
    }

    if (socket === publisher) {
      publisher = null;
      publisherSampleRate = null;
      session.setMicExpected(false);
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
