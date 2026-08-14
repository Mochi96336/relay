import { createServer } from 'node:http';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import express from 'express';
import WebSocket, { WebSocketServer } from 'ws';

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
const MAX_OFFSET_MS = 500;
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

type ClientRole = 'publisher' | 'monitor' | 'unknown';
type RelaySocket = WebSocket & {
  role: ClientRole;
  sampleRate?: number;
  isAlive: boolean;
};

type MicChunk = {
  start: number;
  samples: Int16Array;
};

type TimelineStatus = {
  connected?: boolean;
  videoId?: string;
  state?: number;
  serverTime?: number;
  playbackRate?: number;
};

let publisher: RelaySocket | null = null;
let publisherSampleRate: number | null = null;
let micGainDb = 30;
let voiceOffsetMs = 0;
let testActive = false;
let testStartedAt = 0;
let testFrameIndex = 0;
let youtubeBackingActive = false;
let youtubeBackingStartedAt = 0;
let youtubeBackingFrameIndex = 0;
let micHistory: MicChunk[] = [];
let micTotalSamples = 0;

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

function testStatusPayload() {
  const mode = testActive ? 'click' : youtubeBackingActive ? 'youtube-backing' : 'off';
  return {
    type: 'test-status',
    active: mode !== 'off',
    mode,
    bpm: testActive ? TEST_BPM : 0,
    sampleRate: MIX_SAMPLE_RATE,
    prebufferMs: testActive ? TEST_PREBUFFER_MS : 0,
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
}

function clearMicHistory() {
  micHistory = [];
  micTotalSamples = 0;
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

function appendMic(buffer: Buffer) {
  if (!publisherSampleRate) return;
  const samples = resampleToMixRate(buffer, publisherSampleRate);
  if (samples.length === 0) return;
  micHistory.push({ start: micTotalSamples, samples });
  micTotalSamples += samples.length;
}

function firstChunkAtOrBefore(sampleIndex: number) {
  let low = 0;
  let high = micHistory.length - 1;
  let result = 0;

  while (low <= high) {
    const mid = (low + high) >> 1;
    if (micHistory[mid].start <= sampleIndex) {
      result = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return result;
}

function readMicRange(startSample: number, count: number) {
  const output = new Int16Array(count);
  if (micHistory.length === 0) return output;

  let outputOffset = 0;
  let cursor = startSample;

  if (cursor < 0) {
    const silence = Math.min(count, -cursor);
    outputOffset += silence;
    cursor += silence;
  }

  if (outputOffset >= count || cursor >= micTotalSamples) return output;

  let chunkIndex = firstChunkAtOrBefore(cursor);
  while (chunkIndex < micHistory.length && outputOffset < count) {
    const chunk = micHistory[chunkIndex];
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

function trimMicHistory(beforeSample: number) {
  while (micHistory.length > 1) {
    const chunk = micHistory[0];
    const end = chunk.start + chunk.samples.length;
    if (end >= beforeSample) break;
    micHistory.shift();
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

function mixedFrame(frameIndex: number) {
  const startSample = frameIndex * MIX_FRAME_SAMPLES;
  const offsetSamples = Math.round((voiceOffsetMs * MIX_SAMPLE_RATE) / 1000);
  const mic = readMicRange(startSample - offsetSamples, MIX_FRAME_SAMPLES);
  const gain = 10 ** (micGainDb / 20);
  const output = Buffer.allocUnsafe(MIX_FRAME_SAMPLES * 2);

  for (let i = 0; i < MIX_FRAME_SAMPLES; i += 1) {
    const micValue = (mic[i] / 32768) * gain;
    const backingValue = clickSample(startSample + i);
    const mixed = Math.max(-1, Math.min(1, micValue + backingValue));
    const intSample = mixed < 0 ? Math.round(mixed * 32768) : Math.round(mixed * 32767);
    output.writeInt16LE(intSample, i * 2);
  }

  const retentionSamples = Math.round(((MAX_OFFSET_MS + 1000) * MIX_SAMPLE_RATE) / 1000);
  trimMicHistory(startSample - retentionSamples);
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
    const intSample = value < 0 ? Math.round(value * 32768) : Math.round(value * 32767);
    output.writeInt16LE(intSample, i * 2);
  }

  return output;
}

function startSyncTest() {
  if (youtubeBackingActive) stopYoutubeBacking();
  testActive = true;
  testStartedAt = Date.now();
  testFrameIndex = 0;
  clearMicHistory();
  broadcastJson(testStatusPayload());
  broadcastJson(mixSettingsPayload());
}

function stopSyncTest() {
  if (!testActive) return;
  testActive = false;
  clearMicHistory();
  broadcastJson(testStatusPayload());
  broadcastStatus();
}

function startYoutubeBacking() {
  const timeline = currentTimelineStatus();
  if (!timeline.connected || !timeline.videoId) return false;

  if (testActive) stopSyncTest();
  youtubeBackingActive = true;
  youtubeBackingStartedAt = performance.now();
  youtubeBackingFrameIndex = 0;
  clearMicHistory();
  broadcastJson(youtubeBackingStatusPayload());
  broadcastJson(testStatusPayload());
  return true;
}

function stopYoutubeBacking() {
  if (!youtubeBackingActive) return;
  youtubeBackingActive = false;
  clearMicHistory();
  broadcastJson(youtubeBackingStatusPayload());
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
      broadcastToMonitors(mixedFrame(testFrameIndex), true);
      testFrameIndex += 1;
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
}, 250);

wss.on('connection', (rawSocket) => {
  const socket = rawSocket as RelaySocket;
  socket.role = 'unknown';
  socket.isAlive = true;

  socket.on('pong', () => {
    socket.isAlive = true;
  });

  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      if (socket !== publisher || socket.role !== 'publisher') return;
      const buffer = data as Buffer;
      if (testActive) {
        appendMic(buffer);
      } else if (!youtubeBackingActive) {
        broadcastToMonitors(buffer, true);
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

    if (payload.type === 'youtube-backing-status-request') {
      sendJson(socket, youtubeBackingStatusPayload());
      return;
    }

    if (payload.type === 'start-youtube-backing') {
      if (!startYoutubeBacking()) {
        sendJson(socket, {
          type: 'error',
          message: 'YouTube timeline is not live yet. Load and play a video first.',
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

      const sampleRate = Number(payload.sampleRate);
      if (!Number.isFinite(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) {
        sendJson(socket, { type: 'error', message: 'Invalid sample rate.' });
        return;
      }

      socket.role = 'publisher';
      socket.sampleRate = sampleRate;
      publisher = socket;
      publisherSampleRate = sampleRate;
      sendJson(socket, { type: 'registered', role: 'publisher' });
      sendJson(socket, testStatusPayload());
      sendJson(socket, mixSettingsPayload());
      sendJson(socket, youtubeTimeline.statusPayload());
      sendJson(socket, youtubeBackingStatusPayload());
      broadcastStatus();
      return;
    }

    if (payload.type === 'register' && payload.role === 'monitor') {
      socket.role = 'monitor';
      sendJson(socket, { type: 'registered', role: 'monitor' });
      sendJson(socket, publisherStatusPayload());
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
      startSyncTest();
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
      if (Number.isFinite(nextOffset)) voiceOffsetMs = Math.max(-MAX_OFFSET_MS, Math.min(MAX_OFFSET_MS, nextOffset));
      broadcastJson(mixSettingsPayload());
    }
  });

  socket.on('close', () => {
    if (socket === publisher) {
      publisher = null;
      publisherSampleRate = null;
      stopSyncTest();
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
