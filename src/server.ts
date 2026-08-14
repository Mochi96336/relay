import { createServer } from 'node:http';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import express from 'express';
import WebSocket, { WebSocketServer } from 'ws';

import { analyzeTimingCalibration } from './timing-calibration.js';
import { YouTubeTimelineTracker } from './youtube-timeline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../public');
const port = Number(process.env.PORT ?? 3000);
const relayKey = process.env.RELAY_KEY ?? null;

const MIX_SAMPLE_RATE = 48_000;
const MIX_FRAME_MS = 20;
const MIX_FRAME_SAMPLES = Math.round((MIX_SAMPLE_RATE * MIX_FRAME_MS) / 1000);
const TEST_BPM = 120;
const TEST_PREBUFFER_MS = 800;
const LIVE_MIX_PREBUFFER_MS = 2_500;
const LIVE_BACKING_GAIN = 0.65;
const MAX_OFFSET_MS = 500;
const TIMING_CALIBRATION_MS = 6_000;
const TIMING_CALIBRATION_SAMPLES = Math.round((MIX_SAMPLE_RATE * TIMING_CALIBRATION_MS) / 1000);
const MAX_VOCAL_FINE_TUNE_MS = 100;
const YOUTUBE_BACKING_LOOKAHEAD_MS = 40;

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
};

type PcmChunk = {
  start: number;
  samples: Int16Array;
};

type PcmHistory = {
  chunks: PcmChunk[];
  totalSamples: number;
};

type TimelineStatus = {
  connected?: boolean;
  videoId?: string;
  state?: number;
  serverTime?: number;
  playbackRate?: number;
  transportEstimateMs?: number;
};

type TimingCalibrationPhase = 'idle' | 'collecting' | 'complete' | 'failed';

let publisher: RelaySocket | null = null;
let publisherSampleRate: number | null = null;
let backing: RelaySocket | null = null;
let backingSampleRate: number | null = null;
let micGainDb = 30;
let voiceOffsetMs = 0;
let testActive = false;
let testStartedAt = 0;
let testFrameIndex = 0;
let youtubeBackingActive = false;
let youtubeBackingStartedAt = 0;
let youtubeBackingFrameIndex = 0;
let liveSourceActive = false;
let liveSourceStartedAt = 0;
let liveSourceFrameIndex = 0;
let liveMicNetworkCompMs = 0;
let calibratedMicLagMs: number | null = null;
let vocalFineTuneMs = 0;
let timingCalibrationPhase: TimingCalibrationPhase = 'idle';
let timingCalibrationError: string | null = null;
let timingCalibrationConfidence: number | null = null;
let timingCalibrationSegmentLagsMs: number[] = [];
let timingCalibrationMicChunks: Int16Array[] = [];
let timingCalibrationBackingChunks: Int16Array[] = [];
let timingCalibrationMicSamples = 0;
let timingCalibrationBackingSamples = 0;
const micHistory: PcmHistory = { chunks: [], totalSamples: 0 };
const backingHistory: PcmHistory = { chunks: [], totalSamples: 0 };

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
    if (binary && socket.bufferedAmount > 512 * 1024) continue;
    socket.send(payload, { binary });
  }
}

function publisherStatusPayload() {
  return {
    type: 'publisher-status',
    connected: publisher?.readyState === WebSocket.OPEN,
    sampleRate: publisherSampleRate,
  };
}

function sourceStatusPayload() {
  const timingBaseMs = calibratedMicLagMs ?? liveMicNetworkCompMs;
  return {
    type: 'source-status',
    connected: backing?.readyState === WebSocket.OPEN,
    micConnected: publisher?.readyState === WebSocket.OPEN,
    sampleRate: backingSampleRate,
    active: liveSourceActive,
    prebufferMs: LIVE_MIX_PREBUFFER_MS,
    micNetworkCompensationMs: liveMicNetworkCompMs,
    calibratedMicLagMs,
    timingMode: calibratedMicLagMs === null ? 'network-estimate' : 'acoustic-calibration',
    vocalFineTuneMs,
    appliedMicAdvanceMs: timingBaseMs - vocalFineTuneMs,
  };
}

function timingCalibrationStatusPayload() {
  const capturedSamples = Math.min(timingCalibrationMicSamples, timingCalibrationBackingSamples);
  const progress = timingCalibrationPhase === 'collecting'
    ? Math.max(0, Math.min(1, capturedSamples / TIMING_CALIBRATION_SAMPLES))
    : timingCalibrationPhase === 'complete'
      ? 1
      : 0;
  const timingBaseMs = calibratedMicLagMs ?? liveMicNetworkCompMs;

  return {
    type: 'timing-calibration-status',
    state: timingCalibrationPhase,
    progress,
    durationMs: TIMING_CALIBRATION_MS,
    micLagMs: calibratedMicLagMs,
    confidence: timingCalibrationConfidence,
    segmentLagsMs: timingCalibrationSegmentLagsMs,
    error: timingCalibrationError,
    timingMode: calibratedMicLagMs === null ? 'network-estimate' : 'acoustic-calibration',
    fallbackNetworkMs: liveMicNetworkCompMs,
    vocalFineTuneMs,
    appliedMicAdvanceMs: timingBaseMs - vocalFineTuneMs,
  };
}

function testStatusPayload() {
  const mode = testActive
    ? 'click'
    : youtubeBackingActive
      ? 'youtube-backing'
      : liveSourceActive
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
      : liveSourceActive
        ? LIVE_MIX_PREBUFFER_MS
        : 0,
  };
}

function mixSettingsPayload() {
  return {
    type: 'mix-settings',
    micGainDb,
    voiceOffsetMs,
  };
}

function currentTimelineStatus(nowMs = performance.now()) {
  return youtubeTimeline.statusPayload(nowMs) as TimelineStatus & Record<string, unknown>;
}

function youtubeBackingStatusPayload(nowMs = performance.now()) {
  const timeline = currentTimelineStatus(nowMs);
  return {
    type: 'youtube-backing-status',
    active: youtubeBackingActive,
    available: Boolean(timeline.connected && timeline.videoId),
    sampleRate: MIX_SAMPLE_RATE,
    state: Number.isFinite(Number(timeline.state)) ? Number(timeline.state) : -1,
    positionSeconds: Number.isFinite(Number(timeline.serverTime)) ? Number(timeline.serverTime) : null,
    videoId: typeof timeline.videoId === 'string' ? timeline.videoId : null,
    pattern: 'timecode-tone',
  };
}

function broadcastStatus() {
  broadcastToMonitors(JSON.stringify(publisherStatusPayload()));
  broadcastJson(sourceStatusPayload());
}

function clearHistory(history: PcmHistory) {
  history.chunks = [];
  history.totalSamples = 0;
}

function clearMixHistories() {
  clearHistory(micHistory);
  clearHistory(backingHistory);
}

function clearTimingCalibrationCapture() {
  timingCalibrationMicChunks = [];
  timingCalibrationBackingChunks = [];
  timingCalibrationMicSamples = 0;
  timingCalibrationBackingSamples = 0;
}

function flattenChunks(chunks: Int16Array[], totalSamples: number) {
  const output = new Int16Array(totalSamples);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function failTimingCalibration(message: string) {
  timingCalibrationPhase = 'failed';
  timingCalibrationError = message;
  timingCalibrationConfidence = null;
  timingCalibrationSegmentLagsMs = [];
  clearTimingCalibrationCapture();
  broadcastJson(timingCalibrationStatusPayload());
}

function finishTimingCalibration() {
  timingCalibrationPhase = 'idle';
  try {
    const mic = flattenChunks(timingCalibrationMicChunks, TIMING_CALIBRATION_SAMPLES);
    const backingCapture = flattenChunks(timingCalibrationBackingChunks, TIMING_CALIBRATION_SAMPLES);
    const result = analyzeTimingCalibration(mic, backingCapture, MIX_SAMPLE_RATE);
    calibratedMicLagMs = result.micLagMs;
    timingCalibrationConfidence = result.confidence;
    timingCalibrationSegmentLagsMs = result.segmentLagsMs;
    timingCalibrationError = null;
    timingCalibrationPhase = 'complete';
  } catch (error) {
    timingCalibrationPhase = 'failed';
    timingCalibrationError = error instanceof Error ? error.message : String(error);
    timingCalibrationConfidence = null;
    timingCalibrationSegmentLagsMs = [];
  } finally {
    clearTimingCalibrationCapture();
  }

  broadcastJson(timingCalibrationStatusPayload());
  broadcastJson(sourceStatusPayload());
}

function appendTimingCalibrationSamples(kind: 'mic' | 'backing', samples: Int16Array) {
  if (timingCalibrationPhase !== 'collecting' || samples.length === 0) return;

  const isMic = kind === 'mic';
  const current = isMic ? timingCalibrationMicSamples : timingCalibrationBackingSamples;
  const remaining = Math.max(0, TIMING_CALIBRATION_SAMPLES - current);
  if (remaining === 0) return;

  const kept = samples.length <= remaining ? samples : samples.slice(0, remaining);
  if (isMic) {
    timingCalibrationMicChunks.push(kept);
    timingCalibrationMicSamples += kept.length;
  } else {
    timingCalibrationBackingChunks.push(kept);
    timingCalibrationBackingSamples += kept.length;
  }

  if (
    timingCalibrationMicSamples >= TIMING_CALIBRATION_SAMPLES &&
    timingCalibrationBackingSamples >= TIMING_CALIBRATION_SAMPLES
  ) {
    finishTimingCalibration();
  }
}

function startTimingCalibration() {
  timingCalibrationPhase = 'collecting';
  timingCalibrationError = null;
  timingCalibrationConfidence = null;
  timingCalibrationSegmentLagsMs = [];
  clearTimingCalibrationCapture();
  broadcastJson(timingCalibrationStatusPayload());
}

function resampleToMixRate(buffer: Buffer, sourceRate: number) {
  const inputLength = Math.floor(buffer.byteLength / 2);
  if (inputLength <= 0) return new Int16Array(0);

  const outputLength = Math.max(1, Math.round((inputLength * MIX_SAMPLE_RATE) / sourceRate));
  const output = new Int16Array(outputLength);
  const ratio = sourceRate / MIX_SAMPLE_RATE;

  const readSample = (index: number) => {
    const bounded = Math.max(0, Math.min(inputLength - 1, index));
    return buffer.readInt16LE(bounded * 2);
  };

  for (let i = 0; i < outputLength; i += 1) {
    const position = i * ratio;
    const index = Math.floor(position);
    const fraction = position - index;
    const a = readSample(index);
    const b = readSample(index + 1);
    output[i] = Math.round(a + (b - a) * fraction);
  }

  return output;
}

function appendHistory(history: PcmHistory, buffer: Buffer, sourceRate: number | null) {
  if (!sourceRate) return new Int16Array(0);
  const samples = resampleToMixRate(buffer, sourceRate);
  if (samples.length === 0) return samples;
  history.chunks.push({ start: history.totalSamples, samples });
  history.totalSamples += samples.length;
  return samples;
}

function firstChunkAtOrBefore(history: PcmHistory, sampleIndex: number) {
  let low = 0;
  let high = history.chunks.length - 1;
  let result = 0;

  while (low <= high) {
    const mid = (low + high) >> 1;
    if (history.chunks[mid].start <= sampleIndex) {
      result = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return result;
}

function readHistoryRange(history: PcmHistory, startSample: number, count: number) {
  const output = new Int16Array(count);
  if (history.chunks.length === 0) return output;

  let outputOffset = 0;
  let cursor = startSample;

  if (cursor < 0) {
    const silence = Math.min(count, -cursor);
    outputOffset += silence;
    cursor += silence;
  }

  if (outputOffset >= count || cursor >= history.totalSamples) return output;

  let chunkIndex = firstChunkAtOrBefore(history, cursor);
  while (chunkIndex < history.chunks.length && outputOffset < count) {
    const chunk = history.chunks[chunkIndex];
    const chunkEnd = chunk.start + chunk.samples.length;

    if (cursor >= chunkEnd) {
      chunkIndex += 1;
      continue;
    }

    if (cursor < chunk.start) {
      const silence = Math.min(count - outputOffset, chunk.start - cursor);
      outputOffset += silence;
      cursor += silence;
      continue;
    }

    const sourceOffset = cursor - chunk.start;
    const available = chunk.samples.length - sourceOffset;
    const copyCount = Math.min(count - outputOffset, available);
    output.set(chunk.samples.subarray(sourceOffset, sourceOffset + copyCount), outputOffset);
    outputOffset += copyCount;
    cursor += copyCount;
    chunkIndex += 1;
  }

  return output;
}

function trimHistory(history: PcmHistory, beforeSample: number) {
  while (history.chunks.length > 1) {
    const chunk = history.chunks[0];
    const end = chunk.start + chunk.samples.length;
    if (end >= beforeSample) break;
    history.chunks.shift();
  }
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

function youtubeTimecodeSample(mediaSeconds: number) {
  if (!Number.isFinite(mediaSeconds) || mediaSeconds < 0) return 0;

  const wholeSecond = Math.floor(mediaSeconds);
  const secondPhase = mediaSeconds - wholeSecond;
  const halfBeat = secondPhase < 0.5 ? 0 : 1;
  const pulsePhase = secondPhase - halfBeat * 0.5;
  if (pulsePhase >= 0.085) return 0;

  const notes = [440, 494, 523, 587, 659, 698, 784, 880];
  const noteIndex = ((wholeSecond % notes.length) + notes.length) % notes.length;
  const frequency = notes[noteIndex] * (halfBeat === 0 ? 1 : 1.5);
  const accent = wholeSecond % 4 === 0 && halfBeat === 0;
  const amplitude = accent ? 0.18 : 0.11;
  const envelope = Math.exp(-pulsePhase * 48);
  return Math.sin(2 * Math.PI * frequency * pulsePhase) * amplitude * envelope;
}

function writeMixedSample(output: Buffer, index: number, value: number) {
  const mixed = Math.max(-1, Math.min(1, value));
  const intSample = mixed < 0 ? Math.round(mixed * 32768) : Math.round(mixed * 32767);
  output.writeInt16LE(intSample, index * 2);
}

function clickMixedFrame(frameIndex: number) {
  const startSample = frameIndex * MIX_FRAME_SAMPLES;
  const offsetSamples = Math.round((voiceOffsetMs * MIX_SAMPLE_RATE) / 1000);
  const mic = readHistoryRange(micHistory, startSample - offsetSamples, MIX_FRAME_SAMPLES);
  const gain = 10 ** (micGainDb / 20);
  const output = Buffer.allocUnsafe(MIX_FRAME_SAMPLES * 2);

  for (let i = 0; i < MIX_FRAME_SAMPLES; i += 1) {
    const micValue = (mic[i] / 32768) * gain;
    writeMixedSample(output, i, micValue + clickSample(startSample + i));
  }

  const retentionSamples = Math.round(((MAX_OFFSET_MS + 1000) * MIX_SAMPLE_RATE) / 1000);
  trimHistory(micHistory, startSample - retentionSamples);
  return output;
}

function liveMixedFrame(frameIndex: number) {
  const startSample = frameIndex * MIX_FRAME_SAMPLES;
  // Positive mic lag means the same musical event appears later in the phone
  // microphone stream. Read that many milliseconds further ahead in the mic
  // buffer. Until acoustic calibration succeeds, RTT/2 remains the fallback.
  const timingBaseMs = calibratedMicLagMs ?? liveMicNetworkCompMs;
  const micAdvanceMs = timingBaseMs - vocalFineTuneMs;
  const advanceSamples = Math.round((micAdvanceMs * MIX_SAMPLE_RATE) / 1000);
  const mic = readHistoryRange(micHistory, startSample + advanceSamples, MIX_FRAME_SAMPLES);
  const song = readHistoryRange(backingHistory, startSample, MIX_FRAME_SAMPLES);
  const micGain = 10 ** (micGainDb / 20);
  const output = Buffer.allocUnsafe(MIX_FRAME_SAMPLES * 2);

  for (let i = 0; i < MIX_FRAME_SAMPLES; i += 1) {
    const micValue = (mic[i] / 32768) * micGain;
    const songValue = (song[i] / 32768) * LIVE_BACKING_GAIN;
    writeMixedSample(output, i, micValue + songValue);
  }

  const retentionSamples = Math.round(((MAX_OFFSET_MS + 1000) * MIX_SAMPLE_RATE) / 1000);
  trimHistory(micHistory, startSample - retentionSamples);
  trimHistory(backingHistory, startSample - MIX_SAMPLE_RATE);
  return output;
}

function youtubeBackingFrame(frameAtMs: number) {
  const timeline = currentTimelineStatus(frameAtMs);
  const playing = Boolean(timeline.connected) && Number(timeline.state) === 1;
  const mediaStart = Number(timeline.serverTime);
  const playbackRate = Number(timeline.playbackRate) || 1;
  const output = Buffer.allocUnsafe(MIX_FRAME_SAMPLES * 2);

  for (let i = 0; i < MIX_FRAME_SAMPLES; i += 1) {
    const mediaSeconds = mediaStart + (i / MIX_SAMPLE_RATE) * playbackRate;
    const value = playing ? youtubeTimecodeSample(mediaSeconds) : 0;
    writeMixedSample(output, i, value);
  }

  return output;
}

function startSyncTest() {
  if (liveSourceActive) return false;
  if (youtubeBackingActive) stopYoutubeBacking();
  testActive = true;
  testStartedAt = Date.now();
  testFrameIndex = 0;
  clearHistory(micHistory);
  broadcastJson(testStatusPayload());
  broadcastJson(mixSettingsPayload());
  return true;
}

function stopSyncTest() {
  if (!testActive) return;
  testActive = false;
  clearHistory(micHistory);
  broadcastJson(testStatusPayload());
  broadcastStatus();
}

function startYoutubeBacking() {
  const timeline = currentTimelineStatus();
  if (!timeline.connected || !timeline.videoId || liveSourceActive) return false;

  if (testActive) stopSyncTest();
  youtubeBackingActive = true;
  youtubeBackingStartedAt = performance.now();
  youtubeBackingFrameIndex = 0;
  clearHistory(micHistory);
  broadcastJson(youtubeBackingStatusPayload());
  broadcastJson(testStatusPayload());
  return true;
}

function stopYoutubeBacking() {
  if (!youtubeBackingActive) return;
  youtubeBackingActive = false;
  clearHistory(micHistory);
  broadcastJson(youtubeBackingStatusPayload());
  broadcastJson(testStatusPayload());
  broadcastStatus();
}

function refreshLiveMicNetworkCompensation() {
  const timeline = currentTimelineStatus();
  const transportEstimateMs = Number(timeline.transportEstimateMs);
  liveMicNetworkCompMs = Number.isFinite(transportEstimateMs)
    ? Math.max(0, Math.min(MAX_OFFSET_MS, transportEstimateMs))
    : 0;
}

function resetLiveMixEpoch() {
  liveSourceStartedAt = Date.now();
  liveSourceFrameIndex = 0;
  clearMixHistories();
}

function startLiveSource() {
  if (testActive) stopSyncTest();
  if (youtubeBackingActive) stopYoutubeBacking();
  refreshLiveMicNetworkCompensation();
  liveSourceActive = true;
  resetLiveMixEpoch();
  broadcastJson(sourceStatusPayload());
  broadcastJson(testStatusPayload());
  broadcastJson(mixSettingsPayload());
  broadcastJson(timingCalibrationStatusPayload());
}

function restartLiveSourceAfterMicReconnect() {
  if (!liveSourceActive || backing?.readyState !== WebSocket.OPEN) return;
  refreshLiveMicNetworkCompensation();
  resetLiveMixEpoch();
  if (timingCalibrationPhase === 'collecting') {
    failTimingCalibration('Microphone reconnected during calibration. Start calibration again.');
  }
  broadcastJson(sourceStatusPayload());
  broadcastJson(testStatusPayload());
}

function stopLiveSource() {
  if (!liveSourceActive) return;
  liveSourceActive = false;
  liveMicNetworkCompMs = 0;
  clearMixHistories();
  broadcastJson(sourceStatusPayload());
  broadcastJson(testStatusPayload());
  broadcastStatus();
}

const mixerTimer = setInterval(() => {
  if (testActive) {
    const elapsed = Date.now() - testStartedAt - TEST_PREBUFFER_MS;
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

  if (liveSourceActive) {
    // Keep the captured Source alive while the phone reconnects, but do not
    // advance the shared mix clock without a publisher. Registration resets
    // both histories to a fresh epoch, so reopening Source is unnecessary.
    if (publisher?.readyState !== WebSocket.OPEN) return;

    const elapsed = Date.now() - liveSourceStartedAt - LIVE_MIX_PREBUFFER_MS;
    if (elapsed < 0) return;

    const expectedFrames = Math.floor(elapsed / MIX_FRAME_MS) + 1;
    let framesToSend = Math.min(5, expectedFrames - liveSourceFrameIndex);
    while (framesToSend > 0) {
      broadcastToMonitors(liveMixedFrame(liveSourceFrameIndex), true);
      liveSourceFrameIndex += 1;
      framesToSend -= 1;
    }
    return;
  }

  if (!youtubeBackingActive) return;

  const nowMs = performance.now();
  const expectedFrames = Math.floor(
    (nowMs - youtubeBackingStartedAt + YOUTUBE_BACKING_LOOKAHEAD_MS) / MIX_FRAME_MS,
  ) + 1;
  let framesToSend = Math.min(5, expectedFrames - youtubeBackingFrameIndex);

  while (framesToSend > 0) {
    const frameAtMs = youtubeBackingStartedAt + youtubeBackingFrameIndex * MIX_FRAME_MS;
    broadcastToMonitors(youtubeBackingFrame(frameAtMs), true);
    youtubeBackingFrameIndex += 1;
    framesToSend -= 1;
  }
}, 5);

const youtubeTimelineTimer = setInterval(() => {
  if (youtubeTimeline.hasTelemetry) {
    broadcastJson(youtubeTimeline.statusPayload());
    broadcastJson(youtubeBackingStatusPayload());
  }
  if (timingCalibrationPhase === 'collecting') {
    broadcastJson(timingCalibrationStatusPayload());
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
    if (isBinary) {
      const buffer = data as Buffer;

      if (socket === publisher && socket.role === 'publisher') {
        if (testActive || liveSourceActive) {
          const samples = appendHistory(micHistory, buffer, publisherSampleRate);
          if (liveSourceActive) appendTimingCalibrationSamples('mic', samples);
        } else if (!youtubeBackingActive) {
          broadcastToMonitors(buffer, true);
        }
        return;
      }

      if (socket === backing && socket.role === 'backing' && liveSourceActive) {
        if (publisher?.readyState === WebSocket.OPEN) {
          const samples = appendHistory(backingHistory, buffer, backingSampleRate);
          appendTimingCalibrationSamples('backing', samples);
        }
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
        broadcastJson(youtubeBackingStatusPayload());
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
        !liveSourceActive ||
        backing?.readyState !== WebSocket.OPEN ||
        publisher?.readyState !== WebSocket.OPEN
      ) {
        failTimingCalibration('Connect both phone Microphone and Desktop Source before calibration.');
        return;
      }
      if (!timeline.connected || Number(timeline.state) !== 1) {
        failTimingCalibration('Play YouTube on the phone before calibration.');
        return;
      }
      startTimingCalibration();
      return;
    }

    if (payload.type === 'set-vocal-fine-tune') {
      const nextFineTune = Number(payload.valueMs);
      if (Number.isFinite(nextFineTune)) {
        vocalFineTuneMs = Math.max(
          -MAX_VOCAL_FINE_TUNE_MS,
          Math.min(MAX_VOCAL_FINE_TUNE_MS, nextFineTune),
        );
        broadcastJson(sourceStatusPayload());
        broadcastJson(timingCalibrationStatusPayload());
      }
      return;
    }

    if (payload.type === 'youtube-backing-status-request') {
      sendJson(socket, youtubeBackingStatusPayload());
      return;
    }

    if (payload.type === 'start-youtube-backing') {
      if (!startYoutubeBacking()) {
        sendJson(socket, {
          type: 'error',
          message: liveSourceActive
            ? 'Captured tab source is active. Stop it before using the old timecode follower.'
            : 'YouTube timeline is not live yet. Load and play a video first.',
        });
      }
      return;
    }

    if (payload.type === 'stop-youtube-backing') {
      stopYoutubeBacking();
      return;
    }

    if (payload.type === 'register' && payload.role === 'publisher') {
      if (publisher && publisher !== socket && publisher.readyState === WebSocket.OPEN) {
        sendJson(socket, { type: 'error', message: 'A publisher is already connected.' });
        return;
      }

      const sampleRate = validSampleRate(payload.sampleRate);
      if (!sampleRate) {
        sendJson(socket, { type: 'error', message: 'Invalid sample rate.' });
        return;
      }

      socket.role = 'publisher';
      socket.sampleRate = sampleRate;
      publisher = socket;
      publisherSampleRate = sampleRate;
      restartLiveSourceAfterMicReconnect();
      sendJson(socket, { type: 'registered', role: 'publisher' });
      sendJson(socket, testStatusPayload());
      sendJson(socket, mixSettingsPayload());
      sendJson(socket, youtubeTimeline.statusPayload());
      sendJson(socket, youtubeBackingStatusPayload());
      sendJson(socket, sourceStatusPayload());
      sendJson(socket, timingCalibrationStatusPayload());
      broadcastStatus();
      return;
    }

    if (payload.type === 'register' && payload.role === 'backing') {
      if (backing && backing !== socket && backing.readyState === WebSocket.OPEN) {
        sendJson(socket, { type: 'error', message: 'A captured backing source is already connected.' });
        return;
      }

      const sampleRate = validSampleRate(payload.sampleRate);
      if (!sampleRate) {
        sendJson(socket, { type: 'error', message: 'Invalid backing sample rate.' });
        return;
      }

      socket.role = 'backing';
      socket.sampleRate = sampleRate;
      backing = socket;
      backingSampleRate = sampleRate;
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
      sendJson(socket, youtubeBackingStatusPayload());
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
      if (youtubeBackingActive) stopYoutubeBacking();
      else stopSyncTest();
      return;
    }

    if (payload.type === 'set-mix') {
      const nextGain = Number(payload.micGainDb);
      const nextOffset = Number(payload.voiceOffsetMs);

      if (Number.isFinite(nextGain)) micGainDb = Math.max(0, Math.min(36, nextGain));
      if (Number.isFinite(nextOffset)) {
        voiceOffsetMs = Math.max(-MAX_OFFSET_MS, Math.min(MAX_OFFSET_MS, nextOffset));
      }
      broadcastJson(mixSettingsPayload());
    }
  });

  socket.on('close', () => {
    if (socket === publisher) {
      publisher = null;
      publisherSampleRate = null;
      clearHistory(micHistory);
      if (timingCalibrationPhase === 'collecting') {
        failTimingCalibration('Microphone disconnected during calibration.');
      }
      if (testActive) stopSyncTest();
      broadcastStatus();
    }

    if (socket === backing) {
      backing = null;
      backingSampleRate = null;
      if (timingCalibrationPhase === 'collecting') {
        failTimingCalibration('Desktop Source disconnected during calibration.');
      }
      stopLiveSource();
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
}, 30_000);

wss.on('close', () => {
  clearInterval(heartbeat);
  clearInterval(mixerTimer);
  clearInterval(youtubeTimelineTimer);
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Relay listening on http://localhost:${port}`);
  console.log('For a phone, expose this HTTP server through an HTTPS tunnel before using the microphone.');
});
