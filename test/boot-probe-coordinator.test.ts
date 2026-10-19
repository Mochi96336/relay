import assert from 'node:assert/strict';
import test from 'node:test';

import { BootProbeCoordinator, type BootProbeCoordinatorConfig, type BootProbeHost } from '../src/boot-probe-coordinator.js';
import { CalibrationSession, MAX_CAPTURE_GAP_MS } from '../src/calibration-session.js';
import type { ProbeTarget } from '../src/probe-lifecycle.js';
import { TimingRuntime } from '../src/timing-runtime.js';

const RATE = 48_000;
const CONFIG: BootProbeCoordinatorConfig = {
  sampleRate: RATE, maxAttempts: 2, retryMs: 100, leadMs: 100,
  searchMarginMs: 1_000, minCorrelation: 0.8,
  replyTimeoutMs: 500, analysisTimeoutMs: 1_000, debug: false,
};

function fixture(overrides: Partial<BootProbeCoordinatorConfig> = {}) {
  const config = { ...CONFIG, ...overrides };
  const state = {
    enabled: true, takeBlocked: false, active: true, generation: 10,
    micGeneration: 2, backingGeneration: 3, micSourceRate: RATE, backingSourceRate: RATE,
    reachedSamples: 1_000_000, gapSamples: 0, frontierMissingSamples: 0,
    backingIsRobot: true, robotSourceConnected: true, ready: true,
    calibrationStale: false, staleReads: 0, forbidGenerationRead: false,
    deltaMs: 40, playbackRate: 2,
    latencyMs: { mic: 120, backing: 60 }, correlation: { mic: 0.95, backing: 0.9 },
    pcmReads: 0, evidenceReads: 0, analyses: 0, measured: 0,
    pathReads: [] as ProbeTarget[], backingMeasurements: [] as number[],
  };
  const events: string[] = [];
  const sent: { target: ProbeTarget; requestId: number; leadMs: number }[] = [];
  const settlements: { kind: string; pathDifferenceMs: number | null; contextMatches: boolean }[] = [];
  const context = () => ({
    sessionGeneration: state.generation,
    micGeneration: state.micGeneration, backingGeneration: state.backingGeneration,
    micSourceRate: state.micSourceRate, backingSourceRate: state.backingSourceRate,
  });
  const timing = new TimingRuntime({ autoCalibrationRetryMs: 100 });
  let coordinator: BootProbeCoordinator;
  const calibration = new CalibrationSession({
    sampleRate: RATE, durationMs: 1_000, timeoutMs: 2_000,
    context: () => ({ ...context(), sourceGeneration: 1 }),
    onSettled: () => {
      timing.syncConfirmedAuthority({
        confirmedRevision: calibration.confirmedRevision,
        hasConfirmedResult: calibration.confirmedResult !== null,
      });
      settlements.push({
        kind: timing.authorityKind, pathDifferenceMs: coordinator.pathDifferenceMs,
        contextMatches: coordinator.completedContextMatches(context()),
      });
      events.push('settled');
    },
  });
  let readingTarget: ProbeTarget = 'mic';
  const evidence = () => {
    state.evidenceReads++;
    return { gapSamples: state.gapSamples, frontierMissingSamples: state.frontierMissingSamples, unheaderedSamples: 0 };
  };
  const read = (target: ProbeTarget, count: number) => {
    readingTarget = target;
    state.pcmReads++;
    return new Int16Array(count);
  };
  const host: BootProbeHost = {
    audio: {
      get active() { return state.active; },
      get generation() { return state.generation; },
      get micGeneration() { assert.equal(state.forbidGenerationRead, false); return state.micGeneration; },
      get backingGeneration() { assert.equal(state.forbidGenerationRead, false); return state.backingGeneration; },
      get micTotalSamples() { return state.reachedSamples; },
      get backingTotalSamples() { return state.reachedSamples; },
      sessionSampleAt: (nowMs) => nowMs * RATE / 1_000,
      readMic: (_start, count) => read('mic', count),
      readBacking: (_start, count) => read('backing', count),
      readMicEvidence: evidence, readBackingEvidence: evidence,
      noteMicCalibrationMeasured: () => { state.measured++; events.push('measured'); },
    },
    calibration, timing, context,
    sourceRate: (target) => target === 'mic' ? state.micSourceRate : state.backingSourceRate,
    enabled: () => state.enabled,
    takeBlocked: () => state.takeBlocked,
    calibrationStale: () => { state.staleReads++; return state.calibrationStale; },
    robotRouteActive: () => true,
    topology: () => ({ backingIsRobot: state.backingIsRobot, robotSourceConnected: state.robotSourceConnected }),
    pathReady: (target) => { state.pathReads.push(target); return state.ready; },
    deltaMs: () => state.deltaMs,
    playbackRate: () => state.playbackRate,
    send: (target, request) => { sent.push({ ...request, target }); events.push(`sent:${target}`); },
    changed: () => events.push('changed'),
    onBackingMeasured: (latencyMs) => state.backingMeasurements.push(latencyMs),
  };
  coordinator = new BootProbeCoordinator(config, host, () => {
    state.analyses++;
    return {
      offsetSamples: Math.round((config.searchMarginMs / 8 + state.latencyMs[readingTarget]) * RATE / 1_000),
      correlation: state.correlation[readingTarget],
    };
  });

  function reply(target: ProbeTarget, nowMs: number) {
    const request = sent.at(-1)!;
    assert.equal(request.target, target);
    coordinator.played({ requestId: request.requestId, generation: target === 'mic' ? state.micGeneration : state.backingGeneration }, nowMs);
  }
  function measure(target: ProbeTarget, nowMs: number) {
    coordinator.startIfReady(nowMs);
    reply(target, nowMs + 20);
    coordinator.finishAnalysis(nowMs + 30);
  }
  return { coordinator, state, sent, events, settlements, calibration, timing, context, reply, measure };
}

test('Take ownership, disabled probes and inactive audio cannot request a measurement', () => {
  for (const blocked of ['takeBlocked', 'enabled', 'active'] as const) {
    const f = fixture();
    f.state[blocked] = blocked === 'takeBlocked';
    f.coordinator.startIfReady(0);
    assert.deepEqual(f.sent, []);
    assert.deepEqual(f.state.pathReads, []);
  }
});

test('Robot topology is admitted before sampling a playable leg', () => {
  for (const missing of ['backingIsRobot', 'robotSourceConnected'] as const) {
    const f = fixture();
    f.state[missing] = false;
    f.coordinator.startIfReady(0);
    assert.deepEqual(f.sent, []);
    assert.deepEqual(f.state.pathReads, []);
  }
});

test('a pending request is neither duplicated nor reclassified as a manual run', () => {
  const f = fixture();
  f.coordinator.startIfReady(0);
  f.coordinator.startIfReady(10);
  assert.equal(f.sent.length, 1);
  assert.equal(f.timing.automatic, true);
  assert.equal(f.state.staleReads, 0, 'no calibration exists to sample for staleness');
});

test('a reply from another capture cannot consume the current request', () => {
  const f = fixture();
  f.coordinator.startIfReady(0);
  f.coordinator.played({ requestId: f.sent[0].requestId, generation: 999 }, 20);
  assert.equal(f.coordinator.status(20).phase, 'mic-requested');
  f.reply('mic', 30);
  f.coordinator.finishAnalysis(40);
  assert.equal(f.coordinator.hasMicLeg, true);
  assert.equal(f.state.analyses, 1);
});

for (const outcome of ['played', 'failed'] as const) {
  test(`a stale-session ${outcome} retires the run without reading capture identity or charging an attempt`, () => {
    const f = fixture();
    f.coordinator.startIfReady(0);
    f.state.active = false;
    f.state.forbidGenerationRead = true;
    const reply = { requestId: f.sent[0].requestId, generation: 2, reason: 'late' };
    f.coordinator[outcome](reply, 20);
    assert.equal(f.coordinator.idle, true);
    assert.deepEqual(f.coordinator.status(20).attempts, { mic: 0, backing: 0 });
    assert.equal(f.state.analyses, 0);
  });
}

test('a changed capture after acknowledgement retires analysis before reading sparse PCM', () => {
  const f = fixture();
  f.coordinator.startIfReady(0);
  f.reply('mic', 20);
  f.state.micGeneration++;
  f.coordinator.finishAnalysis(30);
  assert.equal(f.coordinator.idle, true);
  assert.equal(f.state.evidenceReads, 0);
  assert.equal(f.state.pcmReads, 0);
});

test('a stale session outranks an expired analysis deadline', () => {
  const f = fixture();
  f.coordinator.startIfReady(0);
  f.reply('mic', 20);
  f.state.active = false;
  f.state.forbidGenerationRead = true;
  f.coordinator.finishAnalysis(2_000);
  assert.equal(f.coordinator.status(2_000).phase, 'idle');
  assert.deepEqual(f.coordinator.status(2_000).attempts, { mic: 0, backing: 0 });
  assert.equal(f.state.analyses, 0);
});

test('analysis waits for the captured frontier; its deadline consumes the attempt and allows a bounded retry', (t) => {
  t.mock.method(console, 'log', () => {});
  const f = fixture();
  f.state.reachedSamples = 0;
  f.coordinator.startIfReady(0);
  f.reply('mic', 20);
  f.coordinator.finishAnalysis(30);
  assert.equal(f.coordinator.status(30).phase, 'mic-analyzing');
  assert.equal(f.state.evidenceReads, 0);
  f.coordinator.finishAnalysis(1_021);
  assert.equal(f.coordinator.status(1_021).phase, 'mic-retry-wait');
  assert.equal(f.coordinator.status(1_021).attempts.mic, 1);
  f.coordinator.startIfReady(1_050);
  assert.equal(f.sent.length, 1);
  f.coordinator.startIfReady(1_122);
  assert.equal(f.sent.length, 2);
  assert.equal(f.state.analyses, 0);
});

for (const gap of ['missing-frontier', 'source-gap'] as const) {
  test(`${gap} evidence cannot reach the probe correlator`, (t) => {
    t.mock.method(console, 'log', () => {});
    const f = fixture();
    f.state.frontierMissingSamples = gap === 'missing-frontier' ? 1 : 0;
    f.state.gapSamples = gap === 'source-gap' ? Math.ceil(MAX_CAPTURE_GAP_MS * RATE / 1_000) + 1 : 0;
    f.measure('mic', 0);
    assert.equal(f.state.evidenceReads, 1);
    assert.equal(f.state.pcmReads, 0);
    assert.equal(f.state.analyses, 0);
    assert.equal(f.coordinator.status(30).attempts.mic, 1);
  });
}

test('a two-leg result commits evidence and authority before settlement observers run', () => {
  const f = fixture();
  f.measure('mic', 0);
  const beforeBacking = (() => f.calibration.result)();
  assert.equal(beforeBacking, null);
  f.measure('backing', 100);
  assert.equal(f.calibration.result?.micLagMs, 80, '120 ms Mic - 60 ms Robot + 40 ms media / 2');
  assert.equal(f.calibration.result?.confidence, 0.9);
  assert.deepEqual(f.state.backingMeasurements, [60]);
  assert.equal(f.state.measured, 1);
  assert.deepEqual(f.settlements, [{ kind: 'boot-probe', pathDifferenceMs: 60, contextMatches: true }]);
  assert.ok(f.events.indexOf('measured') < f.events.indexOf('settled'));
  assert.notEqual(f.coordinator.completedTimingEvidence, f.coordinator.timingEvidence);
  const requests = f.sent.length;
  f.coordinator.startIfReady(200);
  assert.equal(f.sent.length, requests, 'completed context cannot trigger another automatic probe');
});

test('a rate-only capture change retires the measured Mic leg before choosing the next leg', () => {
  const f = fixture();
  f.measure('mic', 0);
  f.state.micSourceRate = 44_100;
  f.coordinator.startIfReady(100);
  assert.equal(f.sent.at(-1)?.target, 'mic');
  assert.equal(f.coordinator.hasMicLeg, false);
});

test('manual replacement retains confirmed authority and terminal failure restores its provenance', (t) => {
  t.mock.method(console, 'log', () => {});
  const f = fixture({ maxAttempts: 1 });
  f.timing.beginContentCalibration(0, false);
  f.calibration.applyExternalResult({ micLagMs: 75, confidence: 0.9 });
  f.calibration.beginExternalRecalibration();
  f.coordinator.restart(100);
  assert.equal(f.timing.automatic, false);
  assert.equal(f.timing.authorityKind, 'content');
  assert.equal(f.calibration.confirmedResult?.micLagMs, 75);
  f.coordinator.failed({ requestId: f.sent.at(-1)!.requestId, generation: 2, reason: 'could not play' }, 120);
  assert.equal(f.timing.calibrationKind, 'content');
  assert.equal(f.timing.authorityKind, 'content');
  assert.equal(f.calibration.confirmedResult?.micLagMs, 75);
  assert.equal(f.coordinator.status(120).phase, 'failed');
});

test('reapplying player delta updates the retained baseline without inventing a fresh Mic measurement', () => {
  const f = fixture();
  f.measure('mic', 0);
  f.measure('backing', 100);
  f.coordinator.reapply(100, 80);
  assert.equal(f.calibration.result?.micLagMs, 100);
  assert.equal(f.coordinator.calibrationResult?.deltaMs, 80);
  assert.equal(f.state.measured, 1);
  assert.equal(f.timing.authorityKind, 'boot-probe');
});

test('reply timeout diagnostics distinguish retry from exhaustion', (t) => {
  const records: Record<string, unknown>[] = [];
  t.mock.method(console, 'log', (tag: unknown, json: unknown) => {
    assert.equal(tag, '[probe-attempt-failed]');
    records.push(JSON.parse(String(json)));
  });
  const f = fixture();
  f.coordinator.startIfReady(0);
  f.coordinator.expireRequest(501);
  f.coordinator.startIfReady(602);
  f.coordinator.expireRequest(1_103);
  assert.deepEqual(records.map(({ attempt, maxAttempts, terminal }) => ({ attempt, maxAttempts, terminal })), [
    { attempt: 1, maxAttempts: 2, terminal: false },
    { attempt: 2, maxAttempts: 2, terminal: true },
  ]);
  assert.equal(f.coordinator.status(1_103).phase, 'failed');
});

test('an unknown reply does not retire the authoritative request or sample capture identity', () => {
  const f = fixture();
  f.coordinator.startIfReady(0);
  const attempts = f.coordinator.status(0).attempts;
  f.state.forbidGenerationRead = true;
  f.coordinator.failed({ requestId: 999, generation: 2, reason: 'old reply' }, 20);
  f.coordinator.played({ requestId: 999, generation: 2 }, 20);
  assert.equal(f.coordinator.status(20).phase, 'mic-requested');
  assert.deepEqual(f.coordinator.status(20).attempts, attempts);
});

test('an unheard Mic probe terminates instead of replaying notes into headphones indefinitely', (t) => {
  t.mock.method(console, 'log', () => {});
  const f = fixture();
  f.state.correlation.mic = 0.2;
  f.measure('mic', 0);
  f.measure('mic', 200);
  assert.equal(f.coordinator.status(230).micProbeUnheard, true);
  assert.equal(f.coordinator.status(230).phase, 'failed');
  f.coordinator.startIfReady(1_000);
  assert.equal(f.sent.length, 2);
  assert.equal(f.calibration.result, null);
});

test('a new manual request cannot mutate the diagnostic snapshot of the completed measurement', () => {
  const f = fixture();
  f.state.correlation = { mic: 1.2, backing: 1.5 };
  f.measure('mic', 0);
  f.measure('backing', 100);
  assert.equal(f.calibration.result?.confidence, 1, 'promoted confidence is bounded');
  const completed = structuredClone(f.coordinator.completedTimingEvidence);
  f.calibration.beginExternalRecalibration();
  f.coordinator.restart(200);
  assert.equal(f.coordinator.timingEvidence.mic, undefined);
  assert.deepEqual(f.coordinator.completedTimingEvidence, completed);
  f.coordinator.clear();
  assert.equal(f.coordinator.completedTimingEvidence, null);
  assert.equal(f.coordinator.pathDifferenceMs, null);
  assert.equal(f.coordinator.completedContextMatches(f.context()), false);
});
