import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const moduleUrl = new URL('../public/audio-transport.js', import.meta.url).href;
const appUrl = new URL('../public/app.js', import.meta.url);

class FakeSocket {
  readyState = 1;
  bufferedAmount = 0;
  sent: unknown[] = [];

  send(payload: unknown) {
    this.sent.push(payload);
  }
}

test('websocket media fallback has a 200 ms PCM16 realtime ceiling', async () => {
  const {
    DEFAULT_WEBSOCKET_BACKLOG_MS,
    DEFAULT_WEBSOCKET_PCM_SAMPLE_RATE,
    realtimeWebSocketBacklogBytes,
  } = await import(moduleUrl);

  assert.equal(DEFAULT_WEBSOCKET_BACKLOG_MS, 200);
  assert.equal(DEFAULT_WEBSOCKET_PCM_SAMPLE_RATE, 48_000);
  assert.equal(realtimeWebSocketBacklogBytes(), 19_200);
  assert.equal(realtimeWebSocketBacklogBytes(44_100, 200), 17_640);
});

test('legacy byte ceiling can tighten but cannot widen realtime websocket backlog', async () => {
  const { WebSocketAudioTransport } = await import(moduleUrl);
  const wide = new WebSocketAudioTransport({ maxBufferedBytes: 256 * 1024 });
  const tight = new WebSocketAudioTransport({ maxBufferedBytes: 4_096 });
  assert.equal(wide.maxBufferedBytes, 19_200);
  assert.equal(tight.maxBufferedBytes, 4_096);
});

test('websocket bind recalculates the realtime ceiling from the active capture rate', async () => {
  const { WebSocketAudioTransport } = await import(moduleUrl);
  const socket = new FakeSocket();
  const transport = new WebSocketAudioTransport({ maxBufferedBytes: 256 * 1024 });
  transport.bind(socket, { sampleRate: 44_100 });
  assert.equal(transport.maxBufferedBytes, 17_640);

  const tight = new WebSocketAudioTransport({ maxBufferedBytes: 4_096 });
  tight.bind(new FakeSocket(), { sampleRate: 44_100 });
  assert.equal(tight.maxBufferedBytes, 4_096, 'legacy ceiling may still tighten the realtime budget');
});

test('websocket rejects the next packet before it would cross the realtime ceiling', async () => {
  const { WebSocketAudioTransport } = await import(moduleUrl);
  const transport = new WebSocketAudioTransport({ maxBufferedBytes: 256 * 1024 });
  const socket = new FakeSocket();
  transport.bind(socket);

  const packet = new Uint8Array(100);
  socket.bufferedAmount = 19_100;
  assert.equal(transport.send(packet).sent, true);
  assert.equal(socket.sent.length, 1);

  socket.bufferedAmount = 19_101;
  const rejected = transport.send(packet);
  assert.equal(rejected.sent, false);
  assert.equal(rejected.reason, 'congested');
  assert.equal(socket.sent.length, 1);
});

test('preferred transport forwards the capture rate to its websocket fallback', async () => {
  const { PreferredAudioTransport } = await import(moduleUrl);
  const transport = new PreferredAudioTransport({
    maxBufferedBytes: 256 * 1024,
    WebTransportClass: null,
  });
  const socket = new FakeSocket();
  transport.bind(socket, { sampleRate: 44_100 });

  const packet = new Uint8Array(100);
  socket.bufferedAmount = 17_540;
  assert.equal(transport.send(packet).sent, true);
  socket.bufferedAmount = 17_541;
  const rejected = transport.send(packet);
  assert.equal(rejected.sent, false);
  assert.equal(rejected.reason, 'congested');
});

test('preferred transport reports websocket congestion without replaying the rejected packet', async () => {
  const { PreferredAudioTransport } = await import(moduleUrl);
  const transport = new PreferredAudioTransport({
    maxBufferedBytes: 256 * 1024,
    WebTransportClass: null,
  });
  const socket = new FakeSocket();
  socket.bufferedAmount = 19_101;
  transport.bind(socket);

  const result = transport.send(new Uint8Array(100));
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'congested');
  assert.equal(socket.sent.length, 0);
  assert.equal(transport.stats().webSocketCongestedRejects, 1);
});

test('publisher control JSON shares the actual-rate websocket byte ceiling', async () => {
  const { PreferredAudioTransport } = await import(moduleUrl);
  const transport = new PreferredAudioTransport({
    maxBufferedBytes: 256 * 1024,
    WebTransportClass: null,
  });
  const socket = new FakeSocket();
  transport.bind(socket, { sampleRate: 44_100 });

  const payload = { type: 'audio-uplink-health', note: '漢' };
  const encodedBytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
  socket.bufferedAmount = 17_640 - encodedBytes;
  assert.equal(transport.sendControlJson(payload).sent, true, 'exact UTF-8 boundary remains admissible');

  socket.bufferedAmount = 17_641 - encodedBytes;
  const rejected = transport.sendControlJson(payload);
  assert.equal(rejected.sent, false);
  assert.equal(rejected.reason, 'congested');
  assert.equal(socket.sent.length, 1, 'rejected control state is dropped instead of queued for stale replay');
});

test('publisher control JSON always uses websocket backlog authority while media is preferred elsewhere', async () => {
  const { PreferredAudioTransport } = await import(moduleUrl);
  const transport = new PreferredAudioTransport({
    maxBufferedBytes: 256 * 1024,
    WebTransportClass: null,
  });
  const socket = new FakeSocket();
  transport.bind(socket, { sampleRate: 44_100 });

  // Media preference is intentionally independent from the publisher control socket.
  // A live datagram writer must never let control JSON bypass the socket's byte budget.
  transport.datagramWriter = {};
  transport.webTransport = {};
  socket.bufferedAmount = 17_640;
  const result = transport.sendControlJson({ type: 'set-mix', micGainDb: 24 });
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'congested');
  assert.equal(result.path, 'websocket');
});

test('publisher control telemetry is separate from media fallback telemetry', async () => {
  const { PreferredAudioTransport } = await import(moduleUrl);
  const transport = new PreferredAudioTransport({
    maxBufferedBytes: 256 * 1024,
    WebTransportClass: null,
  });
  const socket = new FakeSocket();
  transport.bind(socket);

  assert.equal(transport.sendControlJson({ type: 'audio-uplink-health' }).sent, true);
  socket.bufferedAmount = 19_200;
  assert.equal(transport.sendControlJson({ type: 'set-mix', micGainDb: 24 }).sent, false);

  const stats = transport.stats();
  assert.equal(stats.webSocketControlMessagesSent, 1);
  assert.equal(stats.webSocketControlCongestedRejects, 1);
  assert.equal(stats.webSocketPacketsSent, 0);
  assert.equal(stats.webSocketCongestedRejects, 0);
});

test('publisher binds websocket media with the actual AudioContext sample rate', async () => {
  const app = await readFile(appUrl, 'utf8');
  assert.match(
    app,
    /audioTransport\.bind\(ws, \{ sampleRate: audioContext\.sampleRate \}\)/,
    'production publisher reconnects must preserve the active capture rate in the fallback budget',
  );
});

test('active publisher JSON is bounded while admission and terminal release remain direct', async () => {
  const app = await readFile(appUrl, 'utf8');
  assert.match(app, /sendAudioUplinkHealth\(\)[\s\S]*audioTransport\.sendControlJson\(audioUplinkHealthPayload\(healthRequestId\)\)/);
  assert.match(app, /function sendVocalFineTune\(\)[\s\S]*audioTransport\.sendControlJson\(\{\s*type: 'set-vocal-fine-tune'/);
  assert.match(app, /function sendMixSettings\(\)[\s\S]*audioTransport\.sendControlJson\(\{\s*type: 'set-mix'/);
  assert.match(app, /audioTransport\.sendControlJson\(\{\s*type: 'calibration-probe-played'/);
  assert.match(app, /audioTransport\.sendControlJson\(\{\s*type: 'calibration-probe-failed'/);
  assert.match(app, /audioTransport\.sendControlJson\(\{ type: 'start-timing-calibration' \}\)/);
  assert.match(
    app,
    /closingSocket\.send\(JSON\.stringify\(\{ type: 'release-mic' \}\)\)/,
    'terminal Mic release stays direct so congestion cannot silently turn an explicit release into reconnect grace',
  );
  assert.match(
    app,
    /ws\.send\(JSON\.stringify\(registration\)\);\s*audioTransport\.bind\(ws, \{ sampleRate: audioContext\.sampleRate \}\)/,
    'publisher registration stays an admission message before the bounded active transport is bound',
  );
});

test('invalid realtime websocket budgets fail closed', async () => {
  const { realtimeWebSocketBacklogBytes, WebSocketAudioTransport } = await import(moduleUrl);
  assert.throws(() => realtimeWebSocketBacklogBytes(0, 200), /sampleRate must be positive/);
  assert.throws(() => realtimeWebSocketBacklogBytes(48_000, 0), /backlogMs must be positive/);
  assert.throws(
    () => new WebSocketAudioTransport({ realtimeBufferedBytes: 0 }),
    /realtimeBufferedBytes must be positive/,
  );
  assert.throws(
    () => new WebSocketAudioTransport().bind(new FakeSocket(), { sampleRate: 0 }),
    /sampleRate must be positive/,
  );
});