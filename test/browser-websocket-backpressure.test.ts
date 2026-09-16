import assert from 'node:assert/strict';
import test from 'node:test';

const moduleUrl = new URL('../public/audio-transport.js', import.meta.url).href;

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

test('invalid realtime websocket budgets fail closed', async () => {
  const { realtimeWebSocketBacklogBytes, WebSocketAudioTransport } = await import(moduleUrl);
  assert.throws(() => realtimeWebSocketBacklogBytes(0, 200), /sampleRate must be positive/);
  assert.throws(() => realtimeWebSocketBacklogBytes(48_000, 0), /backlogMs must be positive/);
  assert.throws(
    () => new WebSocketAudioTransport({ realtimeBufferedBytes: 0 }),
    /realtimeBufferedBytes must be positive/,
  );
});
