import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyListenerEvidence,
  createListenerDebugFaultState,
  createListenerFlightRecorder,
} from '../public/listener-diagnostics.js';

test('listener flight recorder keeps only the configured rolling window', () => {
  let now = 0;
  const recorder = createListenerFlightRecorder({
    snapshotCapacity: 2,
    eventCapacity: 2,
    now: () => now,
    wallNow: () => 123_456,
  });

  recorder.recordSnapshot({ contextState: 'running', lastWorkletHealthAgeMs: 0 });
  now = 1;
  recorder.recordSnapshot({ contextState: 'running', lastWorkletHealthAgeMs: 0, marker: 1 });
  now = 2;
  recorder.recordSnapshot({ contextState: 'running', lastWorkletHealthAgeMs: 0, marker: 2 });
  recorder.recordEvent('one');
  recorder.recordEvent('two');
  recorder.recordEvent('three');

  const dump = recorder.dump();
  assert.equal(dump.version, 1);
  assert.equal(dump.generatedAtUnixMs, 123_456);
  assert.deepEqual(dump.snapshots.map((entry) => entry.marker), [1, 2]);
  assert.deepEqual(dump.events.map((entry) => entry.type), ['two', 'three']);
});

test('listener evidence distinguishes expected interruption and transport loss', () => {
  assert.equal(classifyListenerEvidence({
    effectiveMuted: false,
    contextState: 'interrupted',
  }), 'audio-interrupted');

  assert.equal(classifyListenerEvidence({
    effectiveMuted: false,
    contextState: 'running',
    transportEnabled: true,
    lastMonitorFrameAgeMs: 2_000,
    lastWorkletHealthAgeMs: 20,
  }), 'transport-stale');
});

test('listener evidence distinguishes a running context whose worklet stopped reporting', () => {
  assert.equal(classifyListenerEvidence({
    effectiveMuted: false,
    contextState: 'running',
    transportEnabled: true,
    lastMonitorFrameAgeMs: 20,
    lastWorkletHealthAgeMs: 2_000,
  }), 'render-stale');
});

test('internally healthy listener evidence deliberately does not claim audible output', () => {
  assert.equal(classifyListenerEvidence({
    effectiveMuted: false,
    contextState: 'running',
    transportEnabled: true,
    lastMonitorFrameAgeMs: 20,
    lastWorkletHealthAgeMs: 20,
    workletHealth: {
      playing: true,
      queuedMs: 160,
      starvedMs: 0,
    },
  }), 'internally-healthy');
});

test('intentional mute takes precedence over technical liveness evidence', () => {
  assert.equal(classifyListenerEvidence({
    effectiveMuted: true,
    contextState: 'interrupted',
    transportEnabled: true,
    lastMonitorFrameAgeMs: 50_000,
  }), 'intentionally-muted');
});

test('debug fault state expires PCM drop and output silence independently', () => {
  let now = 1_000;
  const faults = createListenerDebugFaultState({ now: () => now });

  faults.dropPcmFor(500);
  faults.silenceOutputFor(1_000);
  assert.equal(faults.shouldDropPcm(), true);
  assert.equal(faults.shouldSilenceOutput(), true);

  now = 1_600;
  assert.equal(faults.shouldDropPcm(), false);
  assert.equal(faults.shouldSilenceOutput(), true);

  now = 2_100;
  assert.equal(faults.shouldSilenceOutput(), false);
  assert.deepEqual(faults.snapshot(), {
    dropPcm: false,
    dropPcmRemainingMs: 0,
    silentOutput: false,
    silentOutputRemainingMs: 0,
  });
});

test('flight recorder normalizes non-finite evidence so dumps stay JSON-safe', () => {
  const recorder = createListenerFlightRecorder({ now: () => 10 });
  recorder.recordSnapshot({
    contextState: 'running',
    lastWorkletHealthAgeMs: Number.POSITIVE_INFINITY,
    workletHealth: { queuedMs: Number.NaN },
  });
  recorder.recordEvent('health', { starvedMs: Number.NEGATIVE_INFINITY });

  const serialized = JSON.stringify(recorder.dump());
  assert.equal(serialized.includes('Infinity'), false);
  assert.equal(serialized.includes('NaN'), false);
});
