import { createServer } from 'node:http';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import express from 'express';
import WebSocket, { WebSocketServer } from 'ws';

import { AudioSession, LIMITER_THRESHOLD_DBFS } from './audio-session.js';
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
let micGainDb = 30;
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
  retentionMs: MAX_OFFSET_MS + 1_000,
});
session.setMicGainDb(micGainDb);

// Bumped by the desktop follower whenever it seeks its mirrored player. The
// follower tolerates 450 ms of error before correcting, so a seek lands the
// song anywhere in that band - and that offset is what a calibration measures.
let sourceGeneration = 0;

function calibrationContext(): CalibrationContext {
  return {
    sessionGeneration: session.generation,
    micGeneration: session.micGeneration,
    sourceGeneration,
  };
}

const calibration = new CalibrationSession({
  sampleRate: MIX_SAMPLE_RATE,
  durationMs: TIMING_CALIBRATION_MS,
  timeoutMs: TIMING_CALIBRATION_TIMEOUT_MS,
  context: calibrationContext,
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
  return {
    type: 'source-status',
    connected: backing?.readyState === WebSocket.OPEN,
    micConnected: publisher?.readyState === WebSocket.OPEN,
    sampleRate: backingSampleRate,
    active: session.active,
    prebufferMs: session.prebufferMs,
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
  };
}

function testStatusPayload() {
  const mode = testActive
    ? 'click'
    : session.active
      ? 'tab-source'
      : 'off';

  return {
    type: 'test-status',
    active: mode !== 'off',
    mode,
    bpm: testActive ? TEST_BPM : 0,
    sampleRate: MIX_SAMPLE_RATE,
    prebufferMs: testActive
      ? TEST_PREBUFFER_MS
      : session.active
        ? session.prebufferMs
        : 0,
  };
}

function mixSettingsPayload() {
  return {
    type: 'mix-settings',
    micGainDb,
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

  const retentionSamples = Math.round(((MAX_OFFSET_MS + 1000) * MIX_SAMPLE_RATE) / 1000);
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
  if (!session.active) return;
  // The next capture can be a different tab, device or output path, so the old
  // measurement must not survive. It used to be process-global and quietly
  // carried over into the next session.
  session.stop();
  calibration.reset();
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

const youtubeTimelineTimer = setInterval(() => {
  const nowMs = performance.now();

  if (youtubeTimeline.hasTelemetry) {
    broadcastJson(youtubeTimeline.statusPayload(nowMs));
  }

  // Without the timeout the phase never leaves 'collecting' when one side stops
  // sending, and the Calibrate button stays disabled with no way back.
  if (calibration.collecting && !calibration.tick(nowMs)) {
    broadcastJson(timingCalibrationStatusPayload());
  }

  if (session.active && nowMs - lastMixHealthAt >= MIX_HEALTH_INTERVAL_MS) {
    lastMixHealthAt = nowMs;
    broadcastJson(mixHealthPayload());
  }
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
      broadcastJson(mixSettingsPayload());
    }
  });

  socket.on('close', () => {
    if (socket.replaced) return;

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
      stopLiveSource();
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
