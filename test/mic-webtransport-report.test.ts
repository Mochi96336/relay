import assert from 'node:assert/strict';
import test from 'node:test';

import type { AudioUplinkHealth } from '../src/audio-uplink-health.js';
import { MicWebTransportReport } from '../src/mic-webtransport-report.js';

function health(generation: number, transport: {
  failure?: string | null;
  path?: 'websocket' | 'webtransport';
  attempts?: number;
  connections?: number;
  retries?: number;
}) {
  return {
    captureGeneration: generation,
    transport: {
      path: transport.path ?? 'websocket',
      webTransportLastFailure: transport.failure ?? null,
      webTransportAttempts: transport.attempts ?? 1,
      webTransportConnections: transport.connections ?? 0,
      webTransportRetries: transport.retries ?? 0,
    },
  } as unknown as AudioUplinkHealth;
}

test('a fallback and the retry that brings WebTransport back are both logged once', () => {
  const report = new MicWebTransportReport();
  assert.equal(report.observe(health(7, {})), null, 'nothing to say before any failure');

  const failed = report.observe(health(7, { failure: 'connect:WebTransportError/session', attempts: 1 }));
  assert.equal(failed?.failure, 'connect:WebTransportError/session');
  assert.equal(failed?.recovered, undefined);
  assert.equal(report.observe(health(7, { failure: 'connect:WebTransportError/session', attempts: 1 })), null);

  // The page keeps its last failure reason after the 2 s retry connects.
  const recovered = report.observe(health(7, {
    failure: 'connect:WebTransportError/session', path: 'webtransport', attempts: 2, connections: 1, retries: 1,
  }));
  assert.deepEqual(recovered, {
    generation: 7,
    failure: 'connect:WebTransportError/session',
    recovered: true,
    path: 'webtransport',
    attempts: 2,
    connections: 1,
    retries: 1,
  });
  assert.equal(report.observe(health(7, {
    failure: 'connect:WebTransportError/session', path: 'webtransport', attempts: 2, connections: 1, retries: 1,
  })), null);
});

test('connections without a failure are ordinary and stay quiet', () => {
  const report = new MicWebTransportReport();
  assert.equal(report.observe(health(3, { path: 'webtransport', connections: 1 })), null);
  assert.equal(report.observe(health(3, { path: 'webtransport', connections: 2 })), null);
});

test('a new capture starts its own history', () => {
  const report = new MicWebTransportReport();
  report.observe(health(1, { failure: 'ready:Error' }));
  const next = report.observe(health(2, { failure: 'ready:Error' }));
  assert.equal(next?.generation, 2, 'the same reason on a new capture is a new failure');
});
