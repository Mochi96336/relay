import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
// Execute the production functions rather than a parallel model of reconnect.
const source = readFileSync(new URL('../public/listen.js', import.meta.url), 'utf8');
const names = ['resetPlaybackHealth', 'resetPlaybackTemporalState', 'publishListenHealth', 'acknowledgeMonitorFrame'];
const functions = names.map(name => {
  const start = source.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, name);
  const end = source.indexOf('\n  }', start);
  assert.ok(end > start, name);
  return source.slice(start, end + 4);
});

test('reconnect clears old health and rejects queued worklet reports until the new epoch', () => {
  const events: any[] = [], messages: any[] = [], acknowledgements: any[] = [];
  let now = 1000;
  const context = vm.createContext({ performance: { now: () => now }, window: {
    relayListenHealth: null, dispatchEvent(event: any) { events.push(event); },
  }, CustomEvent: class { constructor(public type: string, public init: any) {} },
  monitorPcmReceiver: { reset() {} }, listenOpusDecoder: { reset() {} }, listenResampler: { reset() {} },
  playbackNode: { port: { postMessage(message: any) { messages.push(message); } } },
  audioContext: { sampleRate: 48000, state: 'running' },
  target: { send(wire: string) { acknowledgements.push(JSON.parse(wire)); } },
  frame: { generation: 1, firstSampleIndex: 0, sampleCount: 960 },
  MONITOR_ACK_INTERVAL_MS: 100,
  });
  vm.runInContext(`let playbackHealthEpoch = 0, playbackHealthSequence = 0;
    let latestPlaybackHealth = null, lastMonitorAckAt = -Infinity;
    let receiveWindow = { measuredAt: 1000, kbps: 105, bytes: 800, startedAt: 0 };
    ${functions.join('\n')}`, context);
  vm.runInContext(`publishListenHealth({ healthEpoch: 0, queuedMs: 180 });
    acknowledgeMonitorFrame(target, frame);`, context);
  assert.equal(acknowledgements.at(-1).playbackHealth.receivedKbps, 105);
  vm.runInContext('resetPlaybackTemporalState(true);', context);
  assert.equal(messages.at(-1).healthEpoch, 1);
  assert.equal(events.at(-1).init.detail, null);
  assert.equal(vm.runInContext('window.relayListenHealth', context), null);
  vm.runInContext(`publishListenHealth({ healthEpoch: 0, queuedMs: 180 });
    acknowledgeMonitorFrame(target, frame);`, context);
  assert.equal(acknowledgements.at(-1).playbackHealth, undefined,
    'first new-connection ACK must not carry previous queue/throughput');
  now += 100;
  vm.runInContext(`publishListenHealth({ healthEpoch: 1, queuedMs: 30 });
    acknowledgeMonitorFrame(target, frame);`, context);
  const fresh = acknowledgements.at(-1).playbackHealth;
  assert.equal(fresh.queuedMs, 30);
  assert.equal(fresh.receivedKbps, undefined);
  assert.equal(fresh.sequence, 2, 'stale callbacks must not advance the diagnostic sequence');
  assert.equal(fresh.ageMs, 0);
});
