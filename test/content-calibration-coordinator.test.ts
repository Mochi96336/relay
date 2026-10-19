import assert from 'node:assert/strict';
import test from 'node:test';

import { ContentCalibrationCoordinator, type ContentCalibrationConfig, type ContentCalibrationHost } from '../src/content-calibration-coordinator.js';
import { TimingRuntime } from '../src/timing-runtime.js';
import type { TimingCalibrationAnalysis } from '../src/timing-calibration.js';

function analysis(micLagMs: number): TimingCalibrationAnalysis {
  return { micLagMs, confidence: 0.9, segmentLagsMs: [micLagMs], segmentCorrelations: [0.9], micLevelDbfs: -20, backingLevelDbfs: -12 };
}

function fixture(options: { automatic?: boolean; enabled?: boolean; analyze?: ContentCalibrationConfig['validation']['analyze'] } = {}) {
  const state = {
    now: 0, robot: true, bootSettled: true, bootExhausted: false, mapping: true,
    active: true, takeBlocked: false, stale: false,
    backing: true, mic: true, flowing: true, playing: true,
    measured: 0, kindReads: 0,
  };
  const context = { sessionGeneration: 1, micGeneration: 2, backingGeneration: 3, sourceGeneration: 4 };
  const events: string[] = [];
  const liveReads: string[] = [];
  const applications: { kind: string; revision: number; slew: number | null }[] = [];
  const timing = new TimingRuntime({ autoCalibrationRetryMs: 100 });
  let coordinator: ContentCalibrationCoordinator;
  const host: ContentCalibrationHost = {
    timing,
    authority: {
      kind: () => {
        state.kindReads++;
        return timing.appliedCalibrationKind({ hasConfirmedResult: coordinator.measurement.confirmedResult !== null, provisional: coordinator.measurement.status().provisional });
      },
      stale: () => state.stale,
      apply: () => {
        applications.push({ kind: timing.authorityKind, revision: timing.authorityRevision, slew: timing.contentValidationSlewRevision });
        events.push('apply');
      },
    },
    route: {
      robotActive: () => state.robot,
      bootSettled: () => state.bootSettled,
      bootExhausted: () => state.bootExhausted,
      evidenceMappingReady: () => state.mapping,
    },
    media: {
      active: () => state.active,
      backingConnected: () => { liveReads.push('backing'); return state.backing; },
      micControlConnected: () => { liveReads.push('mic'); return state.mic; },
      streamsFlowing: () => { liveReads.push('streams'); return state.flowing; },
      timeline: () => { liveReads.push('timeline'); return { connected: true, state: state.playing ? 1 : 2 }; },
      noteMicMeasured: () => { state.measured++; events.push('measured'); },
    },
    takeBlocked: () => state.takeBlocked,
    timingChanged: () => events.push('timing'),
    sourceChanged: () => events.push('source'),
  };
  coordinator = new ContentCalibrationCoordinator({
    automatic: options.automatic ?? true,
    measurement: { sampleRate: 1_000, durationMs: 100, timeoutMs: 1_000, context: () => context, agreementWindows: 1, analyze: () => analysis(310), now: () => state.now },
    validation: {
      sampleRate: 1_000, durationMs: 100, timeoutMs: 1_000,
      intervalMs: 100, retryMs: 50, deviationThresholdMs: 30, agreementToleranceMs: 25,
      enabled: options.enabled, now: () => state.now, analyze: options.analyze ?? (() => analysis(370)),
    },
  }, host);
  function seed(kind: 'content' | 'boot-probe' = 'content') {
    if (kind === 'content') {
      timing.markContentAuthority();
      coordinator.measurement.applyValidatedResult(analysis(310));
    } else {
      timing.markBootProbeAuthority();
      coordinator.measurement.applyExternalResult({ micLagMs: 310, confidence: 0.9 });
    }
  }
  function tick(nowMs: number) { state.now = nowMs; coordinator.tick(nowMs); }
  function window(index = 0) {
    const pcm = new Int16Array(100);
    coordinator.validation.observeMic(pcm, index * 100);
    coordinator.validation.observeBacking(pcm, index * 100);
  }
  return { coordinator, state, context, timing, events, liveReads, applications, seed, tick, window };
}

for (const gate of ['takeBlocked', 'bootSettled', 'mapping', 'active'] as const) {
  test(`automatic admission rejects ${gate} before reading live media`, () => {
    const f = fixture();
    f.state[gate] = gate === 'takeBlocked';
    f.tick(0);
    assert.equal(f.coordinator.measurement.collecting, false);
    assert.deepEqual(f.liveReads, []);
  });
}

test('disabled automatic calibration leaves manual calibration available', () => {
  const f = fixture({ automatic: false });
  f.tick(0);
  assert.equal(f.coordinator.measurement.collecting, false);
  f.coordinator.startManual(1);
  assert.equal(f.coordinator.measurement.collecting, true);
  assert.equal(f.timing.automatic, false);
});

test('automatic admission reads media in order and suppresses not-yet-due retries', () => {
  const f = fixture();
  f.tick(0);
  assert.deepEqual(f.liveReads, ['backing', 'mic', 'streams', 'timeline']);
  assert.equal(f.coordinator.measurement.collecting, true);
  assert.equal(f.timing.automatic, true);
  f.coordinator.measurement.fail('retry');
  f.liveReads.length = 0;
  f.tick(99);
  assert.deepEqual(f.liveReads, []);
  f.tick(100);
  assert.equal(f.coordinator.measurement.collecting, true);
});

for (const [closed, expected] of [
  ['backing', ['backing']],
  ['mic', ['backing', 'mic']],
  ['flowing', ['backing', 'mic', 'streams']],
] as const) {
  test(`automatic ${closed} rejection does not sample later live readers`, () => {
    const f = fixture();
    f.state[closed] = false;
    f.tick(0);
    assert.deepEqual(f.liveReads, expected);
    assert.equal(f.coordinator.measurement.collecting, false);
  });
}

test('healthy boot authority upgrades to content but cannot become a validation baseline', () => {
  const f = fixture();
  f.seed('boot-probe');
  f.tick(0);
  assert.equal(f.coordinator.measurement.collecting, true);
  assert.equal(f.timing.calibrationKind, 'content');
  assert.equal(f.timing.authorityKind, 'boot-probe');
  assert.equal(f.coordinator.validation.hasBaseline, false);
  assert.equal(f.state.measured, 0);
});

test('fresh content is terminal for automatic starts and arms independent validation', () => {
  const f = fixture();
  f.seed();
  f.tick(0);
  assert.equal(f.coordinator.measurement.collecting, false);
  assert.equal(f.coordinator.validation.status(0).baselineLagMs, 310);
  f.tick(100);
  assert.equal(f.coordinator.validation.collecting, true);
});

test('a fresh non-Robot result is terminal, even if its provenance was boot', () => {
  const f = fixture();
  f.seed('boot-probe');
  f.state.robot = false;
  f.tick(0);
  assert.equal(f.coordinator.measurement.collecting, false);
  assert.deepEqual(f.liveReads, []);
});

test('automatic admission samples authority only for a fresh Robot result', () => {
  for (const fresh of [false, true]) {
    for (const robot of [false, true]) {
      const f = fixture();
      if (fresh) f.seed('boot-probe');
      f.state.robot = robot;
      f.state.kindReads = 0;
      f.tick(0);
      // Baseline synchronization always reads provenance once; automatic
      // admission needs one additional read only for a fresh Robot result.
      assert.equal(f.state.kindReads, fresh && robot ? 2 : 1);
    }
  }
});

test('boot exhaustion preserves primed evidence; a healthy upgrade starts fresh', () => {
  for (const exhausted of [false, true]) {
    const f = fixture();
    f.state.bootExhausted = exhausted;
    f.coordinator.measurement.primeMic(new Int16Array(60), 0);
    f.coordinator.measurement.primeBacking(new Int16Array(60), 0);
    f.tick(0);
    assert.equal(f.coordinator.measurement.status().progress, exhausted ? 0.6 : 0);
  }
});

test('a manual content candidate cannot relabel retained boot authority for validation', () => {
  const f = fixture({ automatic: false });
  f.seed('boot-probe');
  f.coordinator.startManual(0);
  f.tick(100);
  assert.equal(f.timing.calibrationKind, 'content');
  assert.equal(f.timing.authorityKind, 'boot-probe');
  assert.equal(f.coordinator.validation.hasBaseline, false);
});

test('drift promotion synchronizes authority and slew before mixer application and publication', () => {
  const f = fixture();
  f.seed();
  f.tick(0);
  f.tick(100);
  f.window();
  assert.equal(f.coordinator.validation.status(100).state, 'suspect');
  const revision = f.coordinator.measurement.confirmedRevision;
  f.tick(150);
  f.events.length = 0;
  f.window(1);
  assert.equal(f.coordinator.measurement.confirmedRevision, revision + 1);
  assert.deepEqual(f.applications.at(-1), { kind: 'content', revision: revision + 1, slew: revision + 1 });
  assert.deepEqual(f.events.slice(0, 4), ['measured', 'apply', 'timing', 'source']);
  assert.equal(f.timing.contentValidationBaselineRevision, revision + 1);
  f.tick(151);
  assert.equal(f.coordinator.validation.status(151).lastOutcome, 'drift-confirmed');
  assert.equal(f.coordinator.validation.status(151).baselineLagMs, 370);
});

test('Take admission cancels a suspect without revoking confirmed authority', () => {
  const f = fixture();
  f.seed(); f.tick(0); f.tick(100); f.window();
  const revision = f.coordinator.measurement.confirmedRevision;
  f.events.length = 0;
  f.coordinator.standDownForTake(101);
  assert.deepEqual(f.events, ['timing']);
  assert.equal(f.coordinator.validation.status(101).state, 'waiting');
  assert.equal(f.coordinator.measurement.confirmedRevision, revision);
  assert.equal(f.coordinator.measurement.result?.micLagMs, 310);
});

test('Take stand-down retires content collection while keeping its confirmed snapshot', () => {
  const f = fixture();
  f.seed(); f.coordinator.startManual(0);
  const measured = f.state.measured;
  f.events.length = 0;
  f.coordinator.standDownForTake(10);
  assert.deepEqual(f.events, ['apply', 'timing', 'source']);
  assert.equal(f.coordinator.measurement.collecting, false);
  assert.equal(f.coordinator.measurement.result?.micLagMs, 310);
  assert.equal(f.state.measured, measured);
});

test('manual start aborts pending drift analysis and its late answer cannot promote', async () => {
  let resolve!: (result: TimingCalibrationAnalysis) => void;
  let signal: AbortSignal | undefined;
  const pending = new Promise<TimingCalibrationAnalysis>((done) => { resolve = done; });
  const f = fixture({ analyze: (_mic, _backing, _rate, _lag, received) => { signal = received; return pending; } });
  f.seed(); f.tick(0); f.tick(100); f.window();
  assert.equal(signal?.aborted, false);
  const revision = f.coordinator.measurement.confirmedRevision;
  f.coordinator.startManual(101);
  assert.equal(signal?.aborted, true);
  resolve(analysis(400));
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(f.coordinator.measurement.confirmedRevision, revision);
  assert.equal(f.coordinator.measurement.collecting, true);
});

for (const cause of ['takeBlocked', 'mapping', 'bootSettled', 'active', 'flowing'] as const) {
  test(`withdrawn ${cause} readiness cancels suspect validation`, () => {
    const f = fixture();
    f.seed(); f.tick(0); f.tick(100); f.window();
    assert.equal(f.coordinator.validation.status(100).state, 'suspect');
    f.state[cause] = cause === 'takeBlocked';
    f.tick(101);
    assert.equal(f.coordinator.validation.status(101).state, 'waiting');
    assert.equal(f.coordinator.validation.status(101).baselineLagMs, 310);
  });
}

test('stale calibration clears its validation baseline and revision together', () => {
  const f = fixture({ automatic: false });
  f.seed(); f.tick(0);
  f.state.stale = true;
  f.tick(1);
  assert.equal(f.coordinator.validation.hasBaseline, false);
  assert.equal(f.timing.contentValidationBaselineRevision, -1);
});

test('disabled validator retains content diagnostics without collecting', () => {
  const f = fixture({ enabled: false });
  f.seed(); f.tick(0); f.tick(1_000);
  assert.equal(f.coordinator.validation.hasBaseline, true);
  assert.equal(f.coordinator.validation.collecting, false);
});

test('automatic replacement retires pending validation before its old answer can promote', async () => {
  let resolve!: (result: TimingCalibrationAnalysis) => void;
  let signal: AbortSignal | undefined;
  const pending = new Promise<TimingCalibrationAnalysis>((done) => { resolve = done; });
  const f = fixture({ analyze: (_mic, _backing, _rate, _lag, received) => { signal = received; return pending; } });
  f.seed(); f.tick(0); f.tick(100); f.window();
  const revision = f.coordinator.measurement.confirmedRevision;
  f.state.stale = true;
  f.tick(101);
  assert.equal(f.coordinator.measurement.collecting, true);
  assert.equal(f.coordinator.validation.hasBaseline, false);
  assert.equal(signal?.aborted, true);
  resolve(analysis(400));
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(f.coordinator.measurement.confirmedRevision, revision);
  assert.equal(f.timing.automatic, true);
});
