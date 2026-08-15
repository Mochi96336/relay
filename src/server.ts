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

// Real-time timings, overridable so the test suite does not have to spend the
// full production prebuffer and calibration timeout on every run.
function envMs(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const MIX_SAMPLE_RATE = 48_000;
const MIX_FRAME_MS = 20;
const MIX_FRAME_SAMPLES = Math.round((MIX_SAMPLE_RATE * MIX_FRAME_MS) / 1000);
const TEST_BPM = 120;
const TEST_PREBUFFER_MS = 800;
// Both timelines are placed by absolute sample index, so transport delay decides
// when audio lands, not where. What the prebuffer has to cover is the read-ahead
// alone: `margin = prebuffer - appliedMicAdvanceMs`.
//
// It is also a pure output delay - the monitor hears everything this many
// milliseconds late - which at the old 4 s made singing along impossible. The
// session clamps the advance to what this affords rather than starving, so
// lowering it costs correction range, not reliability. Measured lags have run
// negative (the desktop player sits behind the phone), and those are paid for
// out of retained history instead.
const LIVE_MIX_PREBUFFER_MS = envMs('RELAY_LIVE_PREBUFFER_MS', 400);
const LIVE_BACKING_GAIN = 0.65;
const MAX_OFFSET_MS = 500;
/**
 * How much microphone history stays readable, and so how far behind the mixer
 * can read.
 *
 * This is the ceiling on a *negative* advance, which is the direction a real
 * deployment actually needs: the vocal arrives later than the song it was sung
 * against, so the mixer reads the microphone in the past. Reading behind costs
 * only the memory to keep the history (~96 KB per second at 48 kHz mono), not
 * output latency - that is `RELAY_LIVE_PREBUFFER_MS`, and it is untouched by
 * this.
 *
 * It was `MAX_OFFSET_MS + 1000`, which capped the applicable correction at
 * 1300 ms after the safety margin. A robot take measured a genuine -1790 ms
 * (confidence 0.98, five windows inside 15 ms) and the recording confirmed the
 * vocal sitting that far out, so the old ceiling silently truncated a real
 * measurement by ~500 ms and reported success.
 */
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
type RelaySocket = WebSocket & {
  role: ClientRole;
  sampleRate?: number;
  isAlive: boolean;
  replaced?: boolean;
  /**
   * A `source.html?robot=1` page. It holds no role - it neither publishes nor
   * captures - but it owns the mirrored player, so it is the only client that
   * can play the backing probe or report the robot's own player offset.
   */
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
// Aligned with both sliders: the server is the authority they sync to.
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

// Bumped by the desktop follower whenever it seeks its mirrored player. The
// follower tolerates 450 ms of error before correcting, so a seek lands the
// song anywhere in that band - and that offset is what a calibration measures.
let sourceGeneration = 0;

// The desktop is meant to run unattended, so the measurement cannot wait for
// someone to press a button. Long enough between attempts that a singer who is
// mid-phrase gets a genuinely different six seconds on the next try.
const AUTO_CALIBRATE = process.env.RELAY_AUTO_CALIBRATE !== '0';
const AUTO_CALIBRATION_RETRY_MS = envMs('RELAY_AUTO_CALIBRATION_RETRY_MS', 15_000);
let lastAutoCalibrationAt = -Infinity;
let calibrationWasAutomatic = false;

/**
 * Boot calibration: the alignment measured as three separate, individually
 * unambiguous quantities rather than one ambiguous correlation against the
 * song. See `src/boot-calibration.ts` for the derivation of
 *
 *     advance = micLatency - backingLatency + delta
 *
 * Two of those come from a probe - three clicks at irregular offsets, so no
 * shift but the true one lines them all up - played once down each path:
 *
 *   mic      the phone plays it, its own microphone hears it
 *   backing  the robot's browser plays it into the same null sink the song
 *            goes to, so it arrives through PipeWire exactly as the song does
 *
 * The two paths never meet in the air (the robot renders into a null sink, so
 * nothing it plays is audible), which is why no single probe can measure the
 * whole sum, and why the first attempt at this - one probe, phone speaker to
 * phone mic - was measuring `micLatency` alone and applying it as if it were
 * the total.
 *
 * `delta` needs no probe: the robot's follower already computes its own player
 * error against the server timeline to decide whether to seek, and now reports
 * it.
 */
const PROBE_CALIBRATE = process.env.RELAY_CALIBRATION_PROBE !== '0';
const PROBE_RETRY_MS = envMs('RELAY_CALIBRATION_PROBE_RETRY_MS', 6_000);
// How long the client is told to wait after receiving the request before it
// actually plays: swallows dispatch jitter so "play now" does not mean
// "whenever this message happens to be processed."
const PROBE_LEAD_MS = envMs('RELAY_CALIBRATION_PROBE_LEAD_MS', 200);
/**
 * How far either side of the estimated position to search.
 *
 * This bounds the latency the probe can find at all, so it has to cover the
 * whole plausible range of a path rather than just the round-trip estimate's
 * error. The robot's browser-to-PipeWire path measured close to two seconds,
 * which a 400 ms window would have silently missed.
 */
const PROBE_SEARCH_MARGIN_MS = envMs('RELAY_CALIBRATION_PROBE_SEARCH_MARGIN_MS', 3_000);
const PROBE_MIN_CORRELATION = Number(process.env.RELAY_CALIBRATION_PROBE_MIN_CORRELATION ?? 0.5);
const PROBE_DEBUG = process.env.RELAY_CALIBRATION_PROBE_DEBUG === '1';
const PROBE_REPLY_TIMEOUT_MS = 3_000;
/** Long enough for the probe to play, be captured and reach the server. */
const PROBE_ANALYSIS_TIMEOUT_MS = envMs('RELAY_CALIBRATION_PROBE_ANALYSIS_TIMEOUT_MS', 8_000);

type ProbeTarget = 'mic' | 'backing';

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
/** The mic leg, held while the backing leg is measured. Both describe one run. */
let measuredMicLeg: { targetSample: number; actualSample: number; correlation: number } | null = null;
/** Diagnostic only: what the last probe of each leg scored. */
let lastProbeCorrelation: { mic: number | null; backing: number | null } = { mic: null, backing: null };
/** What the last completed boot calibration described, so it is not re-run for nothing. */
let lastProbeContext: {
  sessionGeneration: number;
  micGeneration: number | null;
  backingGeneration: number | null;
} | null = null;
/**
 * Robot player position minus the server timeline, in ms, as the robot's own
 * follower measures it. Null until a robot source page reports one; without it
 * there is no `delta` term and boot calibration cannot complete.
 */
let robotPlayerOffsetMs: number | null = null;
let robotPlayerOffsetAt = -Infinity;
/** How many robot source pages are connected, so the backing leg has a player. */
let robotSourceCount = 0;
/** The last completed boot calibration, kept for the status payload. */
let lastBootCalibration: BootCalibrationResult | null = null;
/**
 * `micLatency - backingLatency` from the last completed run: the part of the
 * alignment that is a property of the capture pipeline rather than of what is
 * playing, so it survives every seek and only a restarted capture invalidates it.
 */
let bootPathDifferenceMs: number | null = null;
let bootConfidence: number | null = null;
/** How far `delta` must move before the vocal is shifted to follow it. */
const BOOT_DELTA_REAPPLY_MS = envMs('RELAY_CALIBRATION_DELTA_REAPPLY_MS', 40);
/** Past this the reported offset describes a playback position long gone. */
const ROBOT_OFFSET_FRESH_MS = 2_000;

// An open socket is not a running stream. Starting a measurement against a
// phone that has registered but is not sending yet spends the whole window
// waiting for it, and the far side of that wait is not audio anyone lost.
const STREAM_LIVE_MS = 1_000;
// Extra tolerance once a collection is under way, so an ordinary jitter spike
// does not abandon a measurement that would have completed.
const COLLECTION_SILENCE_GRACE_MS = 1_500;
let lastMicFrameAt = -Infinity;
let lastBackingFrameAt = -Infinity;

function bothStreamsFlowing(nowMs: number) {
  return silentSides(nowMs).length === 0;
}

/**
 * Which registered sides are not actually delivering audio.
 *
 * A socket says nothing about this, and the two come apart in a way that is
 * easy to hit: reloading source.html destroys the tab capture, while the
 * extension's own socket lives in an offscreen document and stays open. The
 * server then sees a healthy backing client with no audio behind it.
 */
function silentSides(nowMs: number) {
  const silent: string[] = [];
  if (nowMs - lastMicFrameAt >= STREAM_LIVE_MS) silent.push('phone microphone');
  if (nowMs - lastBackingFrameAt >= STREAM_LIVE_MS) silent.push('desktop capture');
  return silent;
}

// How long the captured song may be missing before the live session is
// declared over. The extension retries after a second, so anything shorter
// turns an ordinary blip into a lost take.
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

const calibration = new CalibrationSession({
  sampleRate: MIX_SAMPLE_RATE,
  durationMs: TIMING_CALIBRATION_MS,
  timeoutMs: TIMING_CALIBRATION_TIMEOUT_MS,
  context: calibrationContext,
  // Nobody reviews an unattended measurement, so repeatability has to do the
  // reviewing. A false positive lands somewhere different every window; a real
  // one does not move.
  agreementWindows: Number(process.env.RELAY_CALIBRATION_AGREEMENT ?? 3),
  agreementToleranceMs: envMs('RELAY_CALIBRATION_TOLERANCE_MS', 25),
  // Full agreement is a floor of agreementWindows * durationMs even in the
  // best case. A single window this confident is worth applying while the
  // rest keep collecting in the background, rather than leaving the mix on
  // the network estimate for that whole stretch. 0.55 sits between the
  // confidence a real match scores in practice (0.6-0.8+) and what a rejected,
  // not-yet-agreeing window scores (0.45-0.6) - it is a working guess, not a
  // substitute for agreement, which still runs and can replace it.
  provisionalConfidence: Number(process.env.RELAY_CALIBRATION_PROVISIONAL_CONFIDENCE ?? 0.55),
  // Was 700 ms, on the reasoning that the desktop follower corrects past
  // 450 ms and nothing physical lives beyond that, so anything further out had
  // to be a beat multiple. A robot take then measured -1790 ms with confidence
  // 0.98 and five windows inside 15 ms - the signature of a true match, not an
  // alias - and the recording confirmed the vocal really was that far out. The
  // reasoning missed that the phone's uplink and the robot's browser playback
  // each add their own delay, neither bounded by the follower's dead band.
  // Searching only to 700 ms did not rule the real answer out as implausible,
  // it made it unmeasurable.
  maxLagMs: envMs('RELAY_CALIBRATION_MAX_LAG_MS', 2_500),
  onSettled: () => {
    const result = calibration.result;
    if (result) session.setAlignment({ calibratedMicLagMs: result.micLagMs });
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
    // A dropped frame is not just a glitch: everything after it moves earlier by
    // 20 ms with nothing recording the fact. Count it so the UI can say so.
    if (binary && socket.bufferedAmount > 512 * 1024) {
      monitorDroppedFrames += 1;
      continue;
    }
    socket.send(payload, { binary });
  }
}

function replacePrevious(previous: RelaySocket | null, next: RelaySocket, message: string) {
  if (!previous || previous === next) return;

  // Detach it from every role check before closing so its own close handler,
  // which fires later, cannot tear down the state the new socket just claimed.
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

// A websocket reconnect does not invalidate anything: the capture keeps counting
// samples through the outage, so the measurement still holds. Only a new capture
// session, or a new live session, changes the transport it folded in.
function calibrationIsStale() {
  return calibration.isStaleFor(calibrationContext());
}

function sourceStatusPayload() {
  const alignment = session.alignment;
  const nowMs = performance.now();
  return {
    type: 'source-status',
    connected: backing?.readyState === WebSocket.OPEN,
    micConnected: publisher?.readyState === WebSocket.OPEN,
    // Connected and streaming are different states, and the gap between them is
    // reachable by simply reloading the source page.
    backingStreaming: nowMs - lastBackingFrameAt < STREAM_LIVE_MS,
    micStreaming: nowMs - lastMicFrameAt < STREAM_LIVE_MS,
    sampleRate: backingSampleRate,
    active: session.active,
    prebufferMs: session.prebufferMs,
    // Monitors receive the mix at this rate while a session is live, whatever
    // rate the phone happens to be capturing at.
    mixSampleRate: MIX_SAMPLE_RATE,
    micNetworkCompensationMs: alignment.networkCompensationMs,
    calibratedMicLagMs: alignment.calibratedMicLagMs,
    timingMode: alignment.calibratedMicLagMs === null ? 'network-estimate' : 'acoustic-calibration',
    calibrationStale: calibrationIsStale(),
    vocalFineTuneMs: alignment.fineTuneMs,
    appliedMicAdvanceMs: session.appliedMicAdvanceMs,
    // Differs from the applied value only when the measurement asked for more
    // than the buffers can absorb, which is the signal to raise the prebuffer.
    requestedMicAdvanceMs: session.requestedMicAdvanceMs,
  };
}

function mixHealthPayload() {
  const health = session.health();

  return {
    type: 'mix-health',
    active: session.active,
    // Gaps the framing made visible: dropped uplink chunks, congestion, or a
    // transport outage the capture kept running through.
    ...health,
    // Carried here rather than with the calibration so the advice tracks the
    // voice as it is now, and keeps working without a calibration at all.
    recommendedMicGainDb: recommendedMicGainDb(health.micPeakDbfs),
    micGainDb,
    monitorDroppedFrames,
    prebufferMs: session.prebufferMs,
  };
}


/**
 * The mic gain that lands singing peaks on the limiter threshold.
 *
 * Derived from the live microphone meter, not from the calibration: the
 * calibration asks the singer to stay quiet for its six seconds, so the level
 * it measures is the room and the phone's own speaker, not the voice the gain
 * has to carry. Measuring the peak directly also removes the guess - an assumed
 * crest factor - that estimating it from RMS would need.
 */
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
    micLagMs: alignment.calibratedMicLagMs,
    timingMode: alignment.calibratedMicLagMs === null ? 'network-estimate' : 'acoustic-calibration',
    calibrationStale: calibrationIsStale(),
    fallbackNetworkMs: alignment.networkCompensationMs,
    vocalFineTuneMs: alignment.fineTuneMs,
    appliedMicAdvanceMs: session.appliedMicAdvanceMs,
    requestedMicAdvanceMs: session.requestedMicAdvanceMs,
    // A probe heard too faintly to trust is not an error - the next one is a
    // few seconds away - but it is invisible without this, and "phone speaker
    // too quiet" is exactly the kind of fault it reports. Per leg, because
    // only one of the two paths is usually the broken one.
    probeCorrelation: lastProbeCorrelation,
    // The three terms behind the applied advance, so a wrong total can be
    // attributed to the path that produced it instead of re-measured blind.
    bootCalibration: lastBootCalibration,
    robotPlayerOffsetMs: performance.now() - robotPlayerOffsetAt <= ROBOT_OFFSET_FRESH_MS
      ? robotPlayerOffsetMs
      : null,
    // An unattended attempt that fails is a retry, not an error the operator
    // has to act on, and the UI says so differently.
    automatic: calibrationWasAutomatic,
    autoCalibrate: AUTO_CALIBRATE,
  };
}

/**
 * The click sync test, and nothing else.
 *
 * This used to report a running live session as `mode: 'tab-source'` with
 * `active: true`, because the clients had no other way to hear that the server
 * was mixing. They therefore ran every live take in test mode - which, among
 * other things, forced the monitor slider to 0 dB and stopped remembering what
 * the user had set. A live session is described by `source-status`; the clients
 * read that now.
 */
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


/** Where the session clock is right now, in 48 kHz samples since the epoch. */













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


/**
 * Brings the captured song online. A session already running is rejoined, not
 * restarted: the extension keeps capturing and counting samples through a
 * socket outage, so its frames land back on the timeline they left. Restarting
 * here used to throw away that timeline - and the microphone's with it - for a
 * reconnect the capture had already survived.
 */
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
  // No epoch reset. Framed PCM states its own position, so the reconnected
  // stream lands back on the existing timeline with a hole exactly as long as
  // the outage, instead of costing every listener another full prebuffer.
  refreshLiveMicNetworkCompensation();
  if (calibration.collecting) {
    calibration.fail('Microphone reconnected during calibration. Start calibration again.');
  }
  broadcastJson(sourceStatusPayload());
  broadcastJson(testStatusPayload());
}

function stopLiveSource() {
  cancelBackingGrace();
  if (!session.active) return;
  // The next capture can be a different tab, device or output path, so the old
  // measurement must not survive. It used to be process-global and quietly
  // carried over into the next session.
  session.stop();
  calibration.reset();
  // The next session should measure straight away rather than serving out this
  // one's retry interval.
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

  // The mix clock is free-running. Without a phone the vocal is simply silent
  // for that stretch; stopping output altogether used to cost the whole take,
  // including the song that was arriving perfectly well.
  session.drain((frame) => broadcastToMonitors(frame, true));
}, 5);

/**
 * Runs the measurement without anyone being at the desktop to press the button.
 *
 * Only fires when there is nothing usable to fall back on - no measurement yet,
 * or one that no longer describes this setup. That deliberately keeps it away
 * from a take in progress: applying a fresh alignment mid-song would shift the
 * vocal audibly, and everything that invalidates a measurement (a reconnect, a
 * new capture, a seek) has already disturbed the take anyway.
 *
 * Failures retry rather than latch. The usual reason to fail is the singer
 * being mid-phrase, which stops being true a few seconds later.
 */
function maybeAutoCalibrate(nowMs: number) {
  if (!AUTO_CALIBRATE) return;
  // A robot source has the two-leg boot probe, which measures both capture
  // paths without the song's beat aliases and does not need 3/3 content
  // agreement. Starting the legacy collector in the same timer tick races the
  // pending probe for one CalibrationSession and can overwrite either result.
  if (PROBE_CALIBRATE && robotSourceCount > 0) return;
  if (!session.active || calibration.collecting) return;
  if (calibration.result !== null && !calibrationIsStale()) return;
  if (nowMs - lastAutoCalibrationAt < AUTO_CALIBRATION_RETRY_MS) return;

  if (backing?.readyState !== WebSocket.OPEN || publisher?.readyState !== WebSocket.OPEN) return;
  if (!bothStreamsFlowing(nowMs)) return;
  const timeline = currentTimelineStatus();
  if (!timeline.connected || Number(timeline.state) !== 1) return;

  lastAutoCalibrationAt = nowMs;
  calibrationWasAutomatic = true;
  calibration.start(nowMs);
  broadcastJson(timingCalibrationStatusPayload());
}

/** The generation whose timeline a probe down this path will land on. */
function probeGeneration(target: ProbeTarget) {
  return target === 'mic' ? session.micGeneration : session.backingGeneration;
}

/** Whether everything a probe down this path needs is present and streaming. */
function probePathReady(target: ProbeTarget, nowMs: number) {
  if (target === 'mic') {
    return publisher?.readyState === WebSocket.OPEN && nowMs - lastMicFrameAt < STREAM_LIVE_MS;
  }
  // The robot's browser plays the backing probe, but it arrives through the
  // same PipeWire capture the song does, so both have to be live.
  return backing?.readyState === WebSocket.OPEN
    && nowMs - lastBackingFrameAt < STREAM_LIVE_MS
    && robotSourceCount > 0;
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
  if (PROBE_DEBUG) console.log(`[probe] ${target} sent #${probeRequestId} generation=${probeGeneration(target)}`);

  const payload = { type: 'play-calibration-probe', target, requestId: probeRequestId, leadMs: PROBE_LEAD_MS };
  // The phone is addressed directly; the robot's source page is an
  // unregistered client, so it is broadcast and each page decides from
  // `?robot=1` whether the backing probe is its job.
  if (target === 'mic') sendJson(publisher!, payload);
  else broadcastJson(payload);
}

/**
 * Runs the two probe legs in sequence, then combines them with the robot's
 * reported player offset.
 *
 * Sequential rather than together so that each leg's search window contains
 * exactly one probe: the same reference is used for both, and two of them
 * overlapping in time would give the correlation two peaks to choose between,
 * which is the ambiguity this whole approach exists to avoid.
 */
function maybeStartProbeCalibration(nowMs: number) {
  if (!PROBE_CALIBRATE) return;
  if (!session.active || calibration.collecting) return;
  if (calibration.result !== null && !calibrationIsStale()) return;
  if (pendingProbe !== null || pendingProbeAnalysis !== null) return;
  if (nowMs - lastProbeAttemptAt < PROBE_RETRY_MS) return;

  // Deliberately not waiting for a `delta` to exist. The probes measure the
  // two path delays, which are properties of the hardware and the capture
  // pipeline and do not depend on anything being played; `delta` is read
  // continuously and folded in afterwards. Requiring playback here would mean
  // no calibration at boot, which is exactly when it should be measured.

  // A completed run stands until the thing it measured changes. Each leg is
  // tied to its own capture, and a seek changes only `delta`, which is read
  // continuously and needs no probe at all.
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

/**
 * The client reports only that it played the probe and for which request -
 * not its own clock. The round trip (this server's own send and receive
 * timestamps) is what maps "when the client scheduled it" onto the session
 * clock, assuming symmetric latency - the same assumption the existing
 * clock-ping RTT estimate already makes.
 *
 * The reply arrives when the client *scheduled* the probe, not when the audio
 * came back: it still has to be played, captured and sent. So this only works
 * out where to look, and the analysis waits for that stretch of timeline to
 * actually arrive.
 */
function handleProbeReply(reply: { requestId: unknown; generation: unknown }, nowMs: number) {
  const pending = pendingProbe;
  pendingProbe = null;
  if (!pending || Number(reply.requestId) !== pending.requestId) return;
  if (!session.active) return;

  // A capture that restarted mid-flight makes the reply describe a timeline
  // the audio will not land on. The server's own view is what decides that;
  // the phone additionally confirms its capture generation, which it knows
  // first-hand, truncated to the uint32 the PCM frame header carries. The
  // robot's page cannot corroborate the backing leg - `backing:stdin` owns
  // that stream, the page only makes the sound - so it is not asked to.
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
    // Only ever later than the estimate: a path stores audio late, never
    // early. Searching earlier would spend the window on positions no real
    // latency can occupy, and give a false peak somewhere to hide.
    windowStart: targetSample - Math.round(marginSamples / 8),
    windowSamples: referenceSamples + marginSamples,
    generation: pending.generation,
    deadlineMs: nowMs + PROBE_ANALYSIS_TIMEOUT_MS,
  };
}

/** Drops a part-finished run so the next attempt starts from the mic leg. */
function abandonProbeRun() {
  pendingProbe = null;
  pendingProbeAnalysis = null;
  measuredMicLeg = null;
}

/** Runs the waiting probe analysis once the audio carrying it has landed. */
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

  // readRange pads a range the timeline has not got to yet with zeros, which
  // would silently correlate against silence instead of the probe.
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
    console.log(
      `[probe] ${waiting.target} correlation=${correlation.toFixed(3)} latencyMs=${latencyMs.toFixed(0)}`,
    );
  }

  if (correlation < PROBE_MIN_CORRELATION) {
    abandonProbeRun();
    broadcastJson(timingCalibrationStatusPayload());
    return;
  }

  const leg = { targetSample: waiting.targetSample, actualSample, correlation };

  if (waiting.target === 'mic') {
    // Held while the backing leg runs. Neither leg means anything alone.
    measuredMicLeg = leg;
    broadcastJson(timingCalibrationStatusPayload());
    return;
  }

  const micLeg = measuredMicLeg;
  measuredMicLeg = null;
  if (micLeg === null) return;

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
  calibration.applyExternalResult({
    micLagMs: result.advanceMs,
    confidence: Math.max(0, Math.min(1, result.confidence)),
  });
}

/** The robot's player offset, or 0 when nothing is playing to have one. */
function currentDeltaMs(nowMs: number) {
  if (robotPlayerOffsetMs === null) return 0;
  return nowMs - robotPlayerOffsetAt <= ROBOT_OFFSET_FRESH_MS ? robotPlayerOffsetMs : 0;
}

/**
 * Folds a moved `delta` into the boot measurement without re-probing.
 *
 * The two probe legs measure path delays - properties of the capture
 * pipeline, fixed until something in it restarts. Only `delta` moves during a
 * session, and it moves for one reason: the robot's player drifting against
 * the phone's and being seeked back. Re-running the probes for that would be
 * measuring two constants again to learn a third term that is already known
 * continuously, and on the phone it would be audible.
 *
 * Applied only past a threshold, because the correction shifts the vocal
 * where it can be heard, and the follower's own dead band means small
 * movements are constant.
 */
function maybeReapplyBootCalibration(nowMs: number) {
  if (bootPathDifferenceMs === null || calibration.collecting) return;
  if (nowMs - robotPlayerOffsetAt > ROBOT_OFFSET_FRESH_MS) return;
  if (lastProbeContext === null) return;
  // The paths themselves changed; the boot numbers no longer describe them and
  // a fresh run is what is needed, not an updated delta.
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
  calibration.applyExternalResult({ micLagMs: advanceMs, confidence: bootConfidence ?? 0 });
}

const youtubeTimelineTimer = setInterval(() => {
  const nowMs = performance.now();

  if (youtubeTimeline.hasTelemetry) {
    broadcastJson(youtubeTimeline.statusPayload(nowMs));
  }

  // Without the timeout the phase never leaves 'collecting' when one side stops
  // sending, and the Calibrate button stays disabled with no way back.
  if (calibration.collecting) {
    const silent = silentSides(nowMs - COLLECTION_SILENCE_GRACE_MS);
    if (silent.length > 0) {
      // Waiting out the full timeout here tells the user nothing; the progress
      // simply stops moving. Say which side went quiet, and say it now.
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

  // A reply that never arrives (socket dropped between the request and the
  // click) would otherwise wedge every future attempt behind pendingProbe.
  if (pendingProbe !== null && nowMs - pendingProbe.serverSentAtMs > PROBE_REPLY_TIMEOUT_MS) {
    pendingProbe = null;
  }

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
    // Any traffic proves the peer is alive. Relying on pong alone let a
    // throttled background tab get terminated mid-recording.
    socket.isAlive = true;

    if (isBinary) {
      const frame = decodePcmFrame(data as Buffer);

      if (socket === publisher && socket.role === 'publisher') {
        if (testActive || session.active) {
          const previousGeneration = session.micGeneration;
          lastMicFrameAt = performance.now();
          const { samples, start } = session.ingestMic(frame, publisherSampleRate);

          if (session.active) {
            // A new capture session can mean a different transport delay, which
            // is only knowable once a frame arrives - registration alone does
            // not say whether the phone restarted its microphone or merely
            // reopened the socket.
            if (session.micGeneration !== previousGeneration && session.alignment.calibratedMicLagMs !== null) {
              broadcastJson(sourceStatusPayload());
              broadcastJson(timingCalibrationStatusPayload());
            }
            calibration.observeMic(samples, start);
          }
        } else {
          broadcastToMonitors(frame.pcm, true);
        }
        return;
      }

      // The captured song no longer waits on the microphone. Both streams carry
      // their own position, so they stay aligned independently and an absent
      // phone costs the mix its vocal, not the whole take.
      if (socket === backing && socket.role === 'backing' && session.active) {
        lastBackingFrameAt = performance.now();
        const { samples, start } = session.ingestBacking(frame, backingSampleRate);
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
      const timeline = currentTimelineStatus();
      if (
        !session.active ||
        backing?.readyState !== WebSocket.OPEN ||
        publisher?.readyState !== WebSocket.OPEN
      ) {
        calibration.fail('Connect both phone Microphone and Desktop Source before calibration.');
        return;
      }
      if (!timeline.connected || Number(timeline.state) !== 1) {
        calibration.fail('Play YouTube on the phone before calibration.');
        return;
      }
      // Registered is not the same as streaming. Without this the collection
      // starts, receives nothing from the silent side, and sits at 0 % for the
      // whole timeout with nothing saying which side is missing.
      const silent = silentSides(performance.now());
      if (silent.length > 0) {
        calibration.fail(
          `No audio arriving from the ${silent.join(' or ')}. `
          + 'Restart the backing source: on a development desktop the source page was probably reloaded, which drops the tab capture.',
        );
        return;
      }
      calibrationWasAutomatic = false;
      calibration.start();
      broadcastJson(timingCalibrationStatusPayload());
      return;
    }

    // The desktop follower moved its player, so whatever offset a measurement
    // found no longer describes where the song sits. Saying so beats letting a
    // confident-looking number be wrong by up to the follower's dead band.
    if (payload.type === 'source-seeked') {
      sourceGeneration += 1;
      if (calibration.collecting) {
        calibration.fail('The desktop player seeked during calibration. Start calibration again.');
      } else {
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

      // Last connection wins. When the phone loses its network the old socket
      // stays OPEN here until the heartbeat notices, and rejecting the retry
      // left the microphone dead for up to a full heartbeat cycle with no
      // further retry, because the client's new socket never closed.
      replacePrevious(publisher, socket, 'Replaced by a newer microphone connection.');

      socket.role = 'publisher';
      socket.sampleRate = sampleRate;
      publisher = socket;
      publisherSampleRate = sampleRate;
      // Starvation only means something for a source that is supposed to be
      // streaming; an absent phone is not a fault the mixer should report.
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
      session.setBackingExpected(true);
      sendJson(socket, { type: 'registered', role: 'backing' });
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
      // The mic leg may only be answered by the phone holding the publisher
      // slot; the backing leg by the robot's source page, which is an
      // unregistered client and identifies itself by the target it answers.
      const fromPublisher = socket === publisher && socket.role === 'publisher';
      const target = payload.target === 'backing' ? 'backing' : 'mic';
      if (target === 'mic' ? fromPublisher : socket.isRobotSource === true) {
        handleProbeReply({ requestId: payload.requestId, generation: payload.generation }, performance.now());
      }
      return;
    }

    if (payload.type === 'robot-source-hello') {
      // Says which pages can play the backing probe. Counted rather than
      // flagged so a reconnecting page does not leave the count stuck on.
      if (!socket.isRobotSource) {
        socket.isRobotSource = true;
        robotSourceCount += 1;
      }
      return;
    }

    if (payload.type === 'robot-player-offset') {
      // The robot's follower already computes this to decide whether to seek.
      // It is `delta` in the boot calibration: the robot's player position
      // minus the server timeline the phone drives.
      const offsetMs = Number(payload.offsetMs);
      if (socket.isRobotSource === true && Number.isFinite(offsetMs)) {
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
      // The song is played by the browser hosting the mirrored player, so this
      // is the server's copy of a setting only that host can apply. Keeping it
      // here is what lets the phone drive it - and the robot has no one at its
      // screen to drive it locally.
      const nextSongLevel = Number(payload.songLevel);
      if (Number.isFinite(nextSongLevel)) {
        songLevel = Math.max(0, Math.min(100, Math.round(nextSongLevel)));
      }
      broadcastJson(mixSettingsPayload());
    }
  });

  socket.on('close', () => {
    if (socket.replaced) return;

    if (socket.isRobotSource) {
      socket.isRobotSource = false;
      robotSourceCount = Math.max(0, robotSourceCount - 1);
    }

    if (socket === publisher) {
      publisher = null;
      publisherSampleRate = null;
      session.setMicExpected(false);
      // Deliberately not cleared: the capture may still be running on the phone
      // and about to reconnect onto the same timeline.
      if (calibration.collecting) {
        calibration.fail('Microphone disconnected during calibration.');
      }
      if (testActive) stopSyncTest();
      broadcastStatus();
    }

    if (socket === backing) {
      backing = null;
      backingSampleRate = null;
      session.setBackingExpected(false);
      if (calibration.collecting) {
        calibration.fail('Desktop Source disconnected during calibration.');
      }
      // Symmetrical with the microphone: the socket dying is not the capture
      // dying. The extension reconnects on its own, so hold the timeline open
      // and only end the session once the source really has gone away.
      cancelBackingGrace();
      backingAbsenceTimer = setTimeout(stopLiveSource, BACKING_GRACE_MS);
      broadcastJson(sourceStatusPayload());
      broadcastStatus();
    }
  });
});

// 30 s meant a dropped phone kept its publisher slot for up to a minute.
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
  // PORT=0 asks the OS for a free port; report the real one so callers (and the
  // test harness) can find it.
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  console.log(`Relay listening on http://localhost:${actualPort}`);
  console.log('For a phone, expose this HTTP server through an HTTPS tunnel before using the microphone.');
});
