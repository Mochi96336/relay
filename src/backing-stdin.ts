import { randomBytes } from 'node:crypto';
import process from 'node:process';

import WebSocket from 'ws';

import { encodePcmFrame } from './pcm-frame.js';

function envNumber(name: string, fallback: number, minimum: number) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum) {
    throw new Error(`${name} must be a number >= ${minimum}.`);
  }
  return value;
}

function relayUrl() {
  const configured = process.env.RELAY_URL
    ?? `ws://127.0.0.1:${process.env.PORT ?? '3000'}/ws`;
  const url = new URL(configured);
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error('RELAY_URL must use ws:// or wss://.');
  }

  const key = process.env.RELAY_KEY;
  if (key && !url.searchParams.has('key')) url.searchParams.set('key', key);
  return url.toString();
}

function relayLabel() {
  const url = new URL(relayUrl());
  url.search = '';
  return url.toString();
}

const SAMPLE_RATE = Math.round(envNumber('RELAY_BACKING_SAMPLE_RATE', 48_000, 8_000));
const FRAME_MS = envNumber('RELAY_BACKING_FRAME_MS', 20, 1);
const FRAME_SAMPLES = Math.max(1, Math.round((SAMPLE_RATE * FRAME_MS) / 1000));
const FRAME_BYTES = FRAME_SAMPLES * 2;
const RECONNECT_MS = envNumber('RELAY_BACKING_RECONNECT_MS', 1_000, 50);
const MAX_BUFFERED_BYTES = envNumber('RELAY_BACKING_MAX_BUFFERED_BYTES', 512 * 1024, 1_024);
/**
 * Explicit deployment identity for the stdin bridge.
 *
 * The robot launcher starts the backing bridge before Chromium has loaded
 * `source.html?robot=1`. Without this bit, the server has a short startup window
 * where both audio streams are live but no robot page has announced itself yet,
 * so the legacy song-content calibrator can win the race. The bridge is the
 * first component that knows which deployment owns this backing stream, so it
 * declares that fact at registration time instead of making the server infer it.
 */
const ROBOT_BACKING = process.env.RELAY_BACKING_ROBOT === '1';
const INFRASTRUCTURE_KEY = process.env.RELAY_INFRA_KEY?.trim() ?? '';
/**
 * How long to throw away audio after the first byte arrives.
 *
 * The capture starts as soon as the shell opens the FIFO, which is before this
 * process exists: `npm run backing:stdin` spends ~1.9 s on npm and tsx startup
 * on a Pi, and every millisecond of that is captured and waiting in the pipe.
 * Consuming it normally makes the first frame sent carry audio that old, and
 * the server anchors the backing timeline to the frame's *arrival*, so the
 * whole timeline ends up stuck that far in the past. Boot calibration measured
 * exactly that: 1675 ms of backing latency against 51 ms of actual audio
 * pipeline (Chromium 11 ms, null sink 0, parec 40 ms).
 *
 * A backlog drains at memory speed, so anything still arriving after a short
 * wall-clock window is live. The cost is this much audio at startup, before
 * anyone is singing.
 */
const STARTUP_FLUSH_MS = envNumber('RELAY_BACKING_STARTUP_FLUSH_MS', 250, 0);

if (process.argv.includes('--help')) {
  process.stdout.write(`Relay robot backing source\n\nReads raw mono signed 16-bit little-endian PCM from stdin and forwards it\nto Relay as the normal framed \"backing\" source.\n\nEnvironment:\n  RELAY_URL                         WebSocket URL (default ws://127.0.0.1:3000/ws)\n  RELAY_KEY                         optional shared Relay key\n  RELAY_INFRA_KEY                   64-hex infrastructure capability (required)\n  RELAY_BACKING_SAMPLE_RATE         input sample rate (default 48000)\n  RELAY_BACKING_FRAME_MS            frame size (default 20)\n  RELAY_BACKING_RECONNECT_MS        reconnect delay (default 1000)\n  RELAY_BACKING_MAX_BUFFERED_BYTES  drop threshold (default 524288)\n  RELAY_BACKING_STARTUP_FLUSH_MS    discard startup backlog (default 250)\n  RELAY_BACKING_ROBOT               declare this backing stream as the robot route (1 enables)\n\nExample:\n  audio-capture-command | npm run backing:stdin\n`);
  process.exit(0);
}

if (!/^[0-9a-f]{64}$/.test(INFRASTRUCTURE_KEY)) {
  throw new Error('RELAY_INFRA_KEY must be set to a 64-character lowercase hexadecimal secret.');
}

const generation = randomBytes(4).readUInt32LE(0);
let sampleCursor = 0;
let socket: WebSocket | null = null;
let registered = false;
let everRegistered = false;
let reconnectTimer: NodeJS.Timeout | null = null;
let stopped = false;
// Annotated, not inferred: `Buffer.alloc` narrows to `Buffer<ArrayBuffer>`,
// while stdin hands out the wider `Buffer<ArrayBufferLike>`.
let pending: Buffer = Buffer.alloc(0);
let droppedFrames = 0;
let lastDropLogAt = 0;
/**
 * Wall-clock instant the startup flush ends, set when the first byte arrives
 * rather than at process start: the window has to cover the backlog draining,
 * and the process may be up well before the capture writes anything.
 */
let flushUntil: number | null = null;
let flushing = STARTUP_FLUSH_MS > 0;
let flushedBytes = 0;
/**
 * Periodic peak of what is actually forwarded, off by default.
 *
 * Splits "the capture is silent" from "the timeline is looking in the wrong
 * place", which from the server alone are the same symptom: a probe window
 * full of zeros.
 */
const LEVEL_LOG_MS = envNumber('RELAY_BACKING_LEVEL_LOG_MS', 0, 0);
let levelPeak = 0;
let lastLevelLogAt = 0;

function log(message: string) {
  process.stderr.write(`[backing] ${message}\n`);
}

function clearReconnect() {
  if (reconnectTimer === null) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function scheduleReconnect() {
  if (stopped || reconnectTimer !== null) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_MS);
}

function connect() {
  if (stopped) return;
  clearReconnect();

  const next = new WebSocket(relayUrl());
  socket = next;
  registered = false;

  next.on('open', () => {
    if (socket !== next) return;
    next.send(JSON.stringify({
      type: 'infrastructure-authenticate',
      key: INFRASTRUCTURE_KEY,
    }));
  });

  next.on('message', (data, isBinary) => {
    if (socket !== next || isBinary) return;

    let message: Record<string, unknown>;
    try {
      message = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      return;
    }

    if (message.type === 'infrastructure-authenticated') {
      next.send(JSON.stringify({
        type: 'register',
        role: 'backing',
        sampleRate: SAMPLE_RATE,
        robot: ROBOT_BACKING,
      }));
      return;
    }

    if (message.type === 'infrastructure-auth-rejected') {
      log(`Relay infrastructure authentication failed: ${String(message.message ?? 'unknown error')}`);
      return;
    }

    if (message.type === 'registered' && message.role === 'backing') {
      registered = true;
      if (!everRegistered) {
        everRegistered = true;
        // Hold the input producer at process startup until Relay is actually
        // ready. After the first registration, transport outages deliberately
        // do not pause capture: those samples become an explicit timeline hole,
        // matching the browser extension's reconnect semantics.
        process.stdin.resume();
      }
      log(`connected to ${relayLabel()} · ${SAMPLE_RATE} Hz · generation ${generation}${ROBOT_BACKING ? ' · robot route' : ''}`);
      return;
    }

    if (message.type === 'backing-sample-boundary-request') {
      const requestId = Number(message.requestId);
      if (registered && Number.isSafeInteger(requestId) && requestId > 0) {
        next.send(JSON.stringify({
          type: 'backing-sample-boundary',
          requestId,
          generation,
          firstSampleIndex: sampleCursor,
        }));
      }
      return;
    }

    if (message.type === 'error') {
      log(`Relay error: ${String(message.message ?? 'unknown error')}`);
    }
  });

  next.on('close', () => {
    if (socket !== next) return;
    socket = null;
    registered = false;
    if (!stopped) {
      log('Relay disconnected; capture timeline continues and transport will retry.');
      scheduleReconnect();
    }
  });

  next.on('error', () => next.close());
}

function sendPcm(pcm: Buffer) {
  const firstSampleIndex = sampleCursor;
  sampleCursor += pcm.byteLength / 2;

  // Once capture has begun, never stop the source clock just because transport
  // is down. Dropped transport data must remain a hole instead of compressing
  // everything that follows earlier on the timeline.
  if (!registered || socket?.readyState !== WebSocket.OPEN) return;

  if (socket.bufferedAmount >= MAX_BUFFERED_BYTES) {
    droppedFrames += 1;
    const now = Date.now();
    if (now - lastDropLogAt >= 2_000) {
      lastDropLogAt = now;
      log(`uplink congested; dropped ${droppedFrames} frames (~${Math.round(droppedFrames * FRAME_MS)} ms)`);
    }
    return;
  }

  if (LEVEL_LOG_MS > 0) {
    for (let i = 0; i + 1 < pcm.byteLength; i += 2) {
      const magnitude = Math.abs(pcm.readInt16LE(i));
      if (magnitude > levelPeak) levelPeak = magnitude;
    }
    const now = Date.now();
    if (now - lastLevelLogAt >= LEVEL_LOG_MS) {
      lastLevelLogAt = now;
      log(`sent peak ${levelPeak} over the last ${Math.round(LEVEL_LOG_MS / 1000)} s`);
      levelPeak = 0;
    }
  }

  socket.send(encodePcmFrame(generation, firstSampleIndex, pcm));
}

function consume(chunk: Buffer) {
  // Discarded rather than counted: `sampleCursor` has to start at live audio,
  // because the server anchors the timeline to where the first frame arrives.
  if (flushing) {
    const now = Date.now();
    if (flushUntil === null) flushUntil = now + STARTUP_FLUSH_MS;
    if (now < flushUntil) {
      flushedBytes += chunk.byteLength;
      return;
    }
    flushing = false;
    log(`discarded ${Math.round((flushedBytes / 2 / SAMPLE_RATE) * 1000)} ms of startup backlog`);
  }

  pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);

  while (pending.length >= FRAME_BYTES) {
    // Copy because ws may retain the Buffer after this function advances the
    // pending window.
    sendPcm(Buffer.from(pending.subarray(0, FRAME_BYTES)));
    pending = pending.subarray(FRAME_BYTES);
  }
}

function stop(exitCode = 0) {
  if (stopped) return;
  stopped = true;
  clearReconnect();
  process.stdin.pause();

  // A final even-length partial frame is still valid PCM. Preserve its sample
  // position rather than silently discarding the tail on a clean shutdown.
  const evenBytes = pending.length - (pending.length % 2);
  if (evenBytes > 0) sendPcm(Buffer.from(pending.subarray(0, evenBytes)));
  pending = Buffer.alloc(0);

  const current = socket;
  socket = null;
  registered = false;
  if (current?.readyState === WebSocket.OPEN) current.close();

  log(`stopped at sample ${sampleCursor}${droppedFrames > 0 ? ` · dropped ${droppedFrames} frames` : ''}`);
  process.exitCode = exitCode;
}

process.stdin.pause();
process.stdin.on('data', (chunk: Buffer) => consume(chunk));
process.stdin.on('end', () => stop(0));
process.stdin.on('error', (error) => {
  log(`stdin error: ${error.message}`);
  stop(1);
});

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

connect();
