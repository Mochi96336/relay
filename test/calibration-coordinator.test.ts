import assert from 'node:assert/strict';
import test from 'node:test';

import { CalibrationCoordinator, type CalibrationCoordinatorHost } from '../src/calibration-coordinator.js';
import { CalibrationSession } from '../src/calibration-session.js';
import { TimingRuntime } from '../src/timing-runtime.js';

function fixture() {
  const events: string[] = [];
  const state = { robot: false, bootSettled: false, changed: false, silent: [] as string[], mappingRevision: 0 };
  const timing = new TimingRuntime({ autoCalibrationRetryMs: 100 });
  const measurement = new CalibrationSession({
    sampleRate: 1_000, durationMs: 100, timeoutMs: 1_000,
    context: () => ({ sessionGeneration: 1, micGeneration: 2, backingGeneration: 3, sourceGeneration: 4 }),
    onSettled: () => {
      timing.syncConfirmedAuthority({ confirmedRevision: measurement.confirmedRevision, hasConfirmedResult: measurement.confirmedResult !== null });
      events.push('settled');
    },
  });
  const applications: { kind: string; transaction: boolean; lag: number | null }[] = [];
  const silenceReads: number[] = [];
  const host: CalibrationCoordinatorHost = {
    content: {
      measurement,
      clearValidationBaseline: () => events.push('clear-validation'),
      cancelValidation: () => { events.push('cancel-validation'); return true; },
      tick: () => events.push(`content:${state.mappingRevision}`),
    },
    probe: {
      clear: () => events.push('probe-clear'),
      abandon: () => events.push('probe-abandon'),
      expireRequest: () => { events.push('expire'); },
      finishAnalysis: () => { events.push('analyze'); },
      startIfReady: () => { events.push('probe-start'); },
      restart: () => { timing.beginBootProbe(false); events.push('probe-restart'); },
    },
    timing,
    route: {
      robotActive: () => state.robot,
      bootSettled: () => state.bootSettled,
      sweepContentTransition: () => { state.mappingRevision++; events.push('mapping'); },
    },
    alignment: {
      apply: () => {
        applications.push({ kind: timing.authorityKind, transaction: measurement.transactionActive, lag: measurement.result?.micLagMs ?? null });
        events.push('apply');
        return state.changed;
      },
      reapplyBoot: () => events.push('reapply'),
    },
    silentSides: (beforeMs) => { silenceReads.push(beforeMs); return state.silent; },
    timingChanged: () => events.push('timing'),
    sourceChanged: () => events.push('source'),
  };
  const coordinator = new CalibrationCoordinator(1_500, host);
  function seed() {
    timing.beginContentCalibration(0, true);
    measurement.applyValidatedResult({ micLagMs: 310, confidence: 0.9, segmentLagsMs: [310], segmentCorrelations: [0.9], micLevelDbfs: -20, backingLevelDbfs: -12 });
    events.length = 0;
  }
  return { coordinator, host, state, timing, measurement, applications, silenceReads, events, seed };
}

test('scheduler retires requests and alignment before analysis; mapping settles before content admission', () => {
  const f = fixture();
  f.coordinator.tick(200);
  assert.deepEqual(f.events, ['expire', 'apply', 'analyze', 'probe-start', 'reapply', 'mapping', 'content:1']);
  assert.deepEqual(f.silenceReads, []);
});

test('alignment changes publish source then timing before admitting new analysis', () => {
  const f = fixture();
  f.state.changed = true;
  f.coordinator.tick(200);
  assert.deepEqual(f.events.slice(0, 5), ['expire', 'apply', 'source', 'timing', 'analyze']);
});

test('an ongoing collection uses the grace horizon and publishes progress before probe service', () => {
  const f = fixture();
  f.timing.beginContentCalibration(0, false);
  f.measurement.start(0);
  f.coordinator.tick(500);
  assert.deepEqual(f.silenceReads, [-1_000]);
  assert.equal(f.measurement.collecting, true);
  assert.deepEqual(f.events.slice(0, 2), ['timing', 'expire']);
});

test('silent-side failure settles before any new probe can inspect authority', () => {
  const f = fixture();
  f.seed();
  f.measurement.start(0);
  f.state.silent = ['microphone', 'backing source'];
  f.coordinator.tick(500);
  assert.equal(f.measurement.collecting, false);
  assert.match(f.measurement.status().error!, /microphone or backing source/);
  assert.equal(f.measurement.result?.micLagMs, 310);
  assert.deepEqual(f.events.slice(0, 3), ['settled', 'expire', 'apply']);
});

test('a timed-out collection settles once without a duplicate progress publication', () => {
  const f = fixture();
  f.measurement.start(0);
  f.coordinator.tick(1_001);
  assert.equal(f.measurement.status().state, 'failed');
  assert.match(f.measurement.status().error!, /timed out/);
  assert.deepEqual(f.events.slice(0, 3), ['settled', 'expire', 'apply']);
  assert.equal(f.events.includes('timing'), false);
});

test('manual boot replacement keeps confirmed content while clearing validation and applying before candidate switch', () => {
  const f = fixture();
  f.seed();
  f.coordinator.startManualBoot(200);
  assert.deepEqual(f.events, ['clear-validation', 'apply', 'probe-restart', 'source']);
  assert.deepEqual(f.applications, [{ kind: 'content', transaction: true, lag: 310 }]);
  assert.equal(f.measurement.result?.micLagMs, 310);
  assert.equal(f.timing.authorityKind, 'content');
  assert.equal(f.timing.calibrationKind, 'boot-probe');
});

test('manual boot replacement retires a running content candidate while keeping confirmed authority', () => {
  const f = fixture();
  f.seed();
  f.measurement.start(0);
  f.coordinator.startManualBoot(200);
  assert.equal(f.measurement.collecting, false);
  assert.equal(f.measurement.transactionActive, true);
  assert.equal(f.measurement.result?.micLagMs, 310);
});

test('a route becoming Robot retires inherited content and opens the automatic retry schedule', () => {
  const f = fixture();
  f.seed();
  f.state.robot = true;
  assert.equal(f.timing.autoCalibrationDue(50), false);
  f.coordinator.retireLegacyForRobot(50);
  assert.deepEqual(f.events, ['clear-validation', 'apply']);
  assert.equal(f.measurement.result, null);
  assert.equal(f.timing.calibrationKind, 'none');
  assert.equal(f.timing.authorityKind, 'none');
  assert.equal(f.timing.autoCalibrationDue(50), true);
});

for (const gate of ['non-Robot', 'boot-settled', 'probe-candidate'] as const) {
  test(`legacy retirement preserves ${gate} authority`, () => {
    const f = fixture();
    f.seed();
    f.state.robot = gate !== 'non-Robot';
    f.state.bootSettled = gate === 'boot-settled';
    if (gate === 'probe-candidate') f.timing.beginBootProbe(false);
    f.coordinator.retireLegacyForRobot(50);
    assert.deepEqual(f.events, []);
    assert.equal(f.measurement.result?.micLagMs, 310);
  });
}

test('periodic service performs the same route retirement before analysis', () => {
  const f = fixture();
  f.seed(); f.state.robot = true;
  f.coordinator.tick(50);
  assert.deepEqual(f.events.slice(0, 5), ['expire', 'clear-validation', 'apply', 'apply', 'analyze']);
  assert.equal(f.measurement.result, null);
});

test('terminal probe expiry settles before route retirement classifies retained content', () => {
  const f = fixture();
  f.seed(); f.state.robot = true;
  f.host.probe.expireRequest = () => { f.state.bootSettled = true; };
  f.coordinator.tick(50);
  assert.equal(f.measurement.result?.micLagMs, 310);
  assert.equal(f.events.includes('clear-validation'), false);
});
