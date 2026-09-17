import assert from 'node:assert/strict';
import test from 'node:test';

const moduleUrl = new URL('../public/audio-transport.js', import.meta.url);

class EventSocket {
  readyState = 1;
  bufferedAmount = 0;
  private readonly listeners = new Map<string, Set<(event: { data: string }) => void>>();

  send(_payload: unknown) {}

  addEventListener(type: string, listener: (event: { data: string }) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: { data: string }) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  emitJson(payload: unknown) {
    const event = { data: JSON.stringify(payload) };
    for (const listener of this.listeners.get('message') ?? []) listener(event);
  }
}

function health(healthRequestId: number, capturedSamples: number, path: 'webtransport' | 'websocket') {
  return {
    type: 'audio-uplink-health',
    version: 1,
    healthRequestId,
    captureGeneration: 7,
    capturedSamples,
    transport: { path },
  };
}

function ack(healthRequestId: number) {
  return {
    type: 'audio-uplink-health-ack',
    version: 1,
    healthRequestId,
    captureGeneration: 7,
    pcm: {
      acceptedFrameSerial: 20,
      receivedPacketSerial: 20,
      mediaPath: 'websocket',
    },
  };
}

test('media recovery correlates an ACK to its healthRequestId when an earlier ACK was never sent', async () => {
  const { PreferredAudioTransport } = await import(moduleUrl.href);
  const transport = new PreferredAudioTransport();
  const socket = new EventSocket();
  transport.bind(socket);

  const observations: Array<{ capturedSamples: number; path: string }> = [];
  (transport as any).mediaPathRecovery.observe = (observation: { capturedSamples: number; path: string }) => {
    observations.push({
      capturedSamples: observation.capturedSamples,
      path: observation.path,
    });
    return { action: 'none', reason: 'test-observation' };
  };

  // Request 41 is accepted by the browser transport, but model the server ACK
  // send failing before any bytes are put on the wire. The physical socket stays
  // current and request 42 later receives a valid correlated ACK.
  assert.equal(transport.sendControlJson(health(41, 1_000, 'webtransport')).sent, true);
  assert.equal(transport.sendControlJson(health(42, 2_000, 'websocket')).sent, true);

  socket.emitJson(ack(42));

  assert.deepEqual(observations, [{
    capturedSamples: 2_000,
    path: 'websocket',
  }]);

  transport.close();
});
