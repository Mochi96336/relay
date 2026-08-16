import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const moduleUrl = new URL('../public/audio-transport.js', import.meta.url);

class FakeSocket {
  readyState = 1;
  bufferedAmount = 0;
  sent: unknown[] = [];

  send(payload: unknown) {
    this.sent.push(payload);
  }
}

describe('browser AudioTransport', () => {
  it('owns media send readiness and congestion instead of capture code', async () => {
    const { WebSocketAudioTransport } = await import(moduleUrl.href);
    const transport = new WebSocketAudioTransport({ maxBufferedBytes: 10 });
    const socket = new FakeSocket();

    assert.equal(transport.send('before').reason, 'disconnected');

    transport.bind(socket);
    assert.equal(transport.send('first').sent, true);
    assert.deepEqual(socket.sent, ['first']);

    socket.bufferedAmount = 10;
    const congested = transport.send('second');
    assert.equal(congested.sent, false);
    assert.equal(congested.reason, 'congested');
    assert.deepEqual(socket.sent, ['first']);
  });

  it('cannot let a stale reconnect close detach the replacement transport', async () => {
    const { WebSocketAudioTransport } = await import(moduleUrl.href);
    const transport = new WebSocketAudioTransport();
    const previous = new FakeSocket();
    const replacement = new FakeSocket();

    transport.bind(previous);
    transport.bind(replacement);
    transport.unbind(previous);
    assert.equal(transport.send('live').sent, true);
    assert.deepEqual(replacement.sent, ['live']);
  });

  it('keeps control WebSocket sends separate from media sends in app.js', () => {
    const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
    assert.match(app, /new WebSocketAudioTransport/);
    assert.match(app, /audioTransport\.send\(/);
    assert.doesNotMatch(app, /socket\.send\(framePcm\(/);
  });
});
