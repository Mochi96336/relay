import assert from 'node:assert/strict';
import test from 'node:test';

import { PreferredAudioTransport } from '../public/audio-transport.js';

const GENERATION = 11;
const ATTEMPTS_PER_WINDOW = 99;
const MEDIA_PACKET_BYTES = 1_000;
const CONGESTED_BUFFERED_BYTES = 18_500;

type MessageListener = (event: { data: string }) => void;

class BrowserSocket {
  readyState = 1;
  bufferedAmount = 0;
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  readonly sent: unknown[] = [];
  private readonly listeners = new Map<string, Set<MessageListener>>();

  send(payload: unknown) {
    this.sent.push(payload);
  }

  close(code?: number, reason?: string) {
    this.closeCalls.push({ code, reason });
    this.readyState = 2;
  }

  addEventListener(type: string, listener: MessageListener) {
    const current = this.listeners.get(type) ?? new Set<MessageListener>();
    current.add(listener);
    this.listeners.set(type, current);
  }

  removeEventListener(type: string, listener: MessageListener) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(message: unknown) {
    const event = { data: JSON.stringify(message) };
    for (const listener of this.listeners.get('message') ?? []) listener(event);
  }
}

test('severe local WebSocket media congestion spends exactly one bounded socket replacement', () => {
  const socket = new BrowserSocket();
  const transport = new PreferredAudioTransport();
  transport.bind(socket);

  let capturedSamples = 0;
  let admittedPackets = 0;

  for (let window = 0; window < 4; window += 1) {
    for (let attempt = 0; attempt < ATTEMPTS_PER_WINDOW; attempt += 1) {
      capturedSamples += 480;

      // One media packet has room in each trio. The next two hit the realtime
      // byte ceiling and become final timeline holes. The control message is
      // much smaller, so it can still pass at the same high bufferedAmount.
      socket.bufferedAmount = attempt % 3 === 0 ? 0 : CONGESTED_BUFFERED_BYTES;
      const result = transport.send(new Uint8Array(MEDIA_PACKET_BYTES));
      if (attempt % 3 === 0) {
        assert.equal(result.sent, true);
        admittedPackets += 1;
      } else {
        assert.equal(result.sent, false);
        assert.equal(result.reason, 'congested');
      }
    }

    socket.bufferedAmount = CONGESTED_BUFFERED_BYTES;
    const health = {
      type: 'audio-uplink-health',
      version: 1,
      captureGeneration: GENERATION,
      capturedSamples,
      transport: { path: 'websocket' },
    };
    assert.equal(
      transport.sendControlJson(health).sent,
      true,
      'control health must remain live while larger media packets are rejected',
    );

    // Relay accepts every media packet the browser actually admitted. Semantic
    // PCM therefore keeps advancing, so only the final-attempt denominator can
    // expose that two thirds of captured media never left the browser.
    socket.emit({
      type: 'audio-uplink-health-ack',
      version: 1,
      captureGeneration: GENERATION,
      pcm: {
        acceptedFrameSerial: admittedPackets,
        receivedPacketSerial: admittedPackets,
        mediaPath: 'websocket',
      },
    });
  }

  const stats = transport.stats();
  const decision = (transport as any).lastMediaRecoveryDecision;
  assert.equal(stats.webSocketPacketsSent, 132);
  assert.equal(stats.webSocketCongestedRejects, 264);
  assert.equal(stats.webSocketControlMessagesSent, 4);
  assert.equal(stats.webSocketControlCongestedRejects, 0);
  assert.equal(decision?.action, 'replace-websocket');
  assert.equal(decision?.reason, 'server-pcm-underdelivery');
  assert.ok(Math.abs(decision?.packetCoverage - (1 / 3)) < 1e-9);
  assert.equal(socket.closeCalls.length, 1);
  assert.equal(socket.closeCalls[0]?.code, 4001);

  transport.close();
});
