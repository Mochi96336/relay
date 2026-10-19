import assert from 'node:assert/strict';
import test from 'node:test';

import { AudioSession } from '../src/audio-session.js';
import { CalibrationAlignment, type CalibrationAlignmentHost } from '../src/calibration-alignment.js';
import { CalibrationSession } from '../src/calibration-session.js';
import { TimingRuntime } from '../src/timing-runtime.js';
import type { BootCalibrationResult } from '../src/boot-calibration.js';

function fixture() {
  const state = {
    now: 0, robot: true, probeEnabled: false, bootSettled: true, source: true,
    song: true, deltaFresh: true, deltaEver: true, contentReady: true, takeBlocked: false,
    targetLag: -86.06 as number | null, deltaMs: 40, rate: 1,
    pathDifferenceMs: 120 as number | null, probeMatches: true,
    bootResult: { advanceMs: 160, micLatencyMs: 180, backingLatencyMs: 60, deltaMs: 40, confidence: 0.9 } as BootCalibrationResult | null,
  };
  const context = { sessionGeneration: 1, micGeneration: 2, backingGeneration: 3, sourceGeneration: 4 };
  const timing = new TimingRuntime({ autoCalibrationRetryMs: 100 });
  const measurement = new CalibrationSession({
    sampleRate: 48_000, durationMs: 1_000, timeoutMs: 2_000, context: () => context,
    onSettled: () => timing.syncConfirmedAuthority({ confirmedRevision: measurement.confirmedRevision, hasConfirmedResult: measurement.confirmedResult !== null }),
  });
  const audio = new AudioSession({ sampleRate: 48_000, frameMs: 20, prebufferMs: 400, backingGain: 0.65, retentionMs: 3_000 });
  audio.start(0);
  const reapplied: { lag: number; delta: number }[] = [];
  const diagnostics: { reason: string; previous: number | null; next: number }[] = [];
  const host: CalibrationAlignmentHost = {
    measurement, audio, timing,
    probe: {
      get pathDifferenceMs() { return state.pathDifferenceMs; },
      get calibrationResult() { return state.bootResult; },
      completedContextMatches: () => state.probeMatches,
      reapply: (lag, delta) => {
        reapplied.push({ lag, delta });
        state.bootResult = { ...state.bootResult!, advanceMs: lag, deltaMs: delta };
        timing.markBootProbeAuthority();
        measurement.applyExternalResult({ micLagMs: lag, confidence: 0.9 });
      },
    },
    context: () => context,
    probeContext: () => context,
    route: {
      robotActive: () => state.robot,
      probeTimingActive: () => state.probeEnabled,
      bootSettled: () => state.bootSettled,
      sourceConnected: () => state.source,
    },
    mapping: {
      roomHasSong: () => state.song,
      deltaFresh: () => state.deltaFresh,
      deltaEverEstablished: () => state.deltaEver,
      contentReady: () => state.contentReady,
      deltaMs: () => state.deltaMs,
      playbackRate: () => state.rate,
      contentLiveLag: () => state.targetLag,
    },
    takeBlocked: () => state.takeBlocked,
    bootReapplied: (reason, previous, next) => diagnostics.push({ reason, previous, next }),
  };
  const alignment = new CalibrationAlignment(150, host, () => state.now);
  function seed(kind: 'content' | 'boot-probe' = 'content', lag = -80) {
    if (kind === 'boot-probe') {
      timing.markBootProbeAuthority();
      measurement.applyExternalResult({ micLagMs: lag, confidence: 0.9 });
    } else {
      timing.markContentAuthority();
      measurement.applyValidatedResult({ micLagMs: lag, confidence: 0.9, segmentLagsMs: [lag], segmentCorrelations: [0.9], micLevelDbfs: -20, backingLevelDbfs: -12 });
    }
  }
  return { state, context, timing, measurement, audio, alignment, reapplied, diagnostics, seed };
}

test('new content revisions reach the mixer after Take and mapping holds, without bypassing ordinary jitter hold', () => {
  const f = fixture();
  f.audio.setAlignment({ calibratedMicLagMs: -131.59 });
  f.seed();
  assert.equal(f.alignment.sync(), true);
  assert.equal(f.audio.alignment.calibratedMicLagMs, -86.06);
  f.state.targetLag = -80;
  assert.equal(f.alignment.sync(), false);
  assert.equal(f.audio.alignment.calibratedMicLagMs, -86.06);
  const firstRevision = f.measurement.confirmedRevision;

  f.state.takeBlocked = true;
  f.seed('content', -60);
  f.state.targetLag = -60;
  assert.equal(f.alignment.sync(), false);
  assert.equal(f.alignment.authority?.revision, firstRevision);
  f.state.takeBlocked = false;
  assert.equal(f.alignment.sync(), true);
  assert.equal(f.audio.alignment.calibratedMicLagMs, -60);
  assert.equal(f.alignment.authority?.revision, firstRevision + 1);

  f.state.contentReady = false;
  f.seed('content', -40);
  f.state.targetLag = -40;
  assert.equal(f.alignment.sync(), false);
  assert.equal(f.alignment.authority?.revision, firstRevision + 1);
  f.state.contentReady = true;
  assert.equal(f.alignment.sync(), true);
  assert.equal(f.audio.alignment.calibratedMicLagMs, -40);
  assert.equal(f.alignment.authority?.revision, firstRevision + 2);

  f.state.source = false;
  assert.equal(f.alignment.sync(), true);
  assert.equal(f.alignment.authority, null);
  f.state.source = true;
  assert.equal(f.alignment.sync(), true);
  assert.equal(f.audio.alignment.calibratedMicLagMs, -40);
});

test('boot to content promotion applies a sub-threshold new authority immediately', () => {
  const f = fixture();
  f.seed('boot-probe', 160);
  f.alignment.sync();
  f.seed('content', 180);
  f.state.targetLag = 180;
  assert.equal(f.alignment.sync(), true);
  assert.equal(f.audio.alignment.calibratedMicLagMs, 180);
  assert.deepEqual(f.alignment.authority, { revision: 2, kind: 'content' });
});

test('an equal target acknowledges its new revision without moving the read head', () => {
  const f = fixture();
  f.seed();
  f.alignment.sync();
  f.seed();
  assert.equal(f.alignment.sync(), false);
  assert.equal(f.alignment.authority?.revision, 2);
  f.state.targetLag = -60;
  assert.equal(f.alignment.sync(), false);
});

test('content validation slews once and repeated synchronization cannot snap the read head to its target', () => {
  const f = fixture();
  f.seed('content', 310);
  f.state.targetLag = 310;
  f.alignment.sync();
  f.timing.prepareContentValidationSlew(f.measurement.confirmedRevision + 1);
  f.seed('content', 510);
  f.state.targetLag = 510;
  assert.equal(f.alignment.sync(), true);
  assert.equal(f.audio.alignment.calibratedMicLagMs, 310);
  assert.equal(f.audio.calibratedMicLagTarget, 510);
  assert.equal(f.timing.contentValidationSlewRevision, null);
  assert.equal(f.alignment.sync(), false);
  assert.equal(f.audio.alignment.calibratedMicLagMs, 310);
  assert.equal(f.audio.calibratedMicLagTarget, 510);
});

test('mapping holds keep the prepared validation slew and pending confirmation intact', () => {
  const f = fixture();
  f.seed('content', 310);
  f.state.targetLag = 310;
  f.alignment.sync();
  f.timing.prepareContentValidationSlew(2);
  f.seed('content', 510);
  f.state.targetLag = 510;
  f.state.contentReady = false;
  assert.equal(f.alignment.sync(), false);
  assert.equal(f.timing.contentValidationSlewRevision, 2);
  assert.equal(f.alignment.authority?.revision, 1);
  f.state.contentReady = true;
  assert.equal(f.alignment.sync(), true);
  assert.equal(f.audio.calibratedMicLagTarget, 510);
  assert.equal(f.audio.alignment.calibratedMicLagMs, 310);
});

test('an unrelated confirmation cannot consume an old validation slew as its own', () => {
  const f = fixture();
  f.seed('content', 310);
  f.state.targetLag = 310;
  f.alignment.sync();
  f.timing.prepareContentValidationSlew(2);
  f.seed('content', 510);
  f.seed('content', 530);
  f.state.targetLag = 530;
  assert.equal(f.alignment.sync(), true);
  assert.equal(f.audio.alignment.calibratedMicLagMs, 530);
  assert.equal(f.timing.contentValidationSlewRevision, null);
});

test('applied provenance queries cannot relabel a retained result or mutate confirmation metadata', () => {
  const f = fixture();
  f.seed();
  f.alignment.sync();
  f.measurement.beginExternalRecalibration();
  f.timing.beginBootProbe(false);
  const before = { revision: f.timing.authorityRevision, kind: f.timing.authorityKind };
  assert.equal(f.alignment.kind, 'content');
  assert.equal(f.alignment.kind, 'content');
  assert.deepEqual({ revision: f.timing.authorityRevision, kind: f.timing.authorityKind }, before);
  assert.equal(f.alignment.authority?.kind, 'content');
});

test('capture/source context changes revoke the alignment and its applied authority together', () => {
  const f = fixture();
  f.seed();
  f.alignment.sync();
  f.context.micGeneration++;
  assert.equal(f.alignment.stale, true);
  assert.equal(f.alignment.desiredLagMs(0), null);
  assert.equal(f.alignment.sync(), true);
  assert.equal(f.audio.alignment.calibratedMicLagMs, null);
  assert.equal(f.alignment.authority, null);
});

test('a non-Robot route uses its measured lag independently of Robot mapping readiness', () => {
  const f = fixture();
  f.state.robot = false;
  f.state.contentReady = false;
  f.state.source = false;
  f.seed('content', 310);
  f.alignment.sync();
  assert.equal(f.audio.alignment.calibratedMicLagMs, 310);
  assert.equal(f.alignment.desiredLagMs(0), 310);
});

test('Take freezes application while desired alignment continues to witness mapping drift', () => {
  const f = fixture();
  f.seed('content', 310);
  f.state.targetLag = 310;
  f.alignment.sync();
  f.state.takeBlocked = true;
  f.state.targetLag = 610;
  assert.equal(f.alignment.desiredLagMs(0), 610);
  assert.equal(f.alignment.sync(), false);
  assert.equal(f.audio.alignment.calibratedMicLagMs, 310);
});

test('diagnostic authority snapshots cannot mutate the application owner', () => {
  const f = fixture();
  f.seed();
  f.alignment.sync();
  const snapshot = f.alignment.authority!;
  Object.defineProperty(snapshot, 'revision', { value: 999 });
  assert.equal(f.alignment.authority?.revision, 1);
});

test('a boot baseline without Song applies only pipeline latency', () => {
  const f = fixture();
  f.seed('boot-probe', 160);
  f.state.song = false;
  assert.equal(f.alignment.desiredLagMs(0), 120);
  assert.equal(f.alignment.sync(), true);
  assert.equal(f.audio.alignment.calibratedMicLagMs, 120);
});

test('a quiet boot delta holds measured alignment but never claims a current desired total', () => {
  const f = fixture();
  f.seed('boot-probe', 160);
  f.alignment.sync();
  f.state.deltaFresh = false;
  assert.equal(f.alignment.sync(), false);
  assert.equal(f.audio.alignment.calibratedMicLagMs, 160);
  assert.equal(f.alignment.desiredLagMs(0), null);
  f.state.deltaEver = false;
  assert.equal(f.alignment.sync(), true);
  assert.equal(f.audio.alignment.calibratedMicLagMs, null);
});

test('boot total without stored delta fails closed instead of reviving historical alignment', () => {
  const f = fixture();
  f.seed('boot-probe', 160);
  f.state.bootResult = null;
  f.audio.setAlignment({ calibratedMicLagMs: 160 });
  assert.equal(f.alignment.sync(), true);
  assert.equal(f.audio.alignment.calibratedMicLagMs, null);
});

test('boot reapplication alone folds the current media delta into retained pipeline evidence', () => {
  const f = fixture();
  f.seed('boot-probe', 160);
  f.alignment.sync();
  f.state.deltaMs = 400;
  f.state.rate = 2;
  assert.equal(f.alignment.desiredLagMs(0), 320);
  assert.equal(f.alignment.sync(), false);
  assert.equal(f.audio.alignment.calibratedMicLagMs, 160);
  f.alignment.reapplyBoot(0);
  assert.deepEqual(f.reapplied, [{ lag: 320, delta: 400 }]);
  assert.deepEqual(f.diagnostics, [{ reason: 'delta-moved', previous: 160, next: 320 }]);
  assert.equal(f.alignment.sync(), true);
  assert.equal(f.audio.alignment.calibratedMicLagMs, 320);
});

test('valid boot evidence can reclaim revoked content, while a mapping hold cannot be reclaimed', () => {
  const f = fixture();
  f.seed('content', 310);
  f.state.targetLag = 310;
  f.alignment.sync();
  f.state.deltaMs = 400;
  f.state.contentReady = false;
  f.alignment.reapplyBoot(0);
  assert.deepEqual(f.reapplied, []);
  f.context.sourceGeneration++;
  f.alignment.reapplyBoot(0);
  assert.deepEqual(f.reapplied, [{ lag: 520, delta: 400 }]);
  assert.equal(f.diagnostics[0].reason, 'reclaim');
  assert.equal(f.alignment.kind, 'boot-probe');
});

for (const gate of ['Take', 'route', 'context', 'delta', 'path', 'collection', 'transaction'] as const) {
  test(`boot reapplication respects the ${gate} fence`, () => {
    const f = fixture();
    f.seed('boot-probe', 160);
    f.alignment.sync();
    f.state.deltaMs = 400;
    if (gate === 'Take') f.state.takeBlocked = true;
    if (gate === 'route') f.state.robot = false;
    if (gate === 'context') f.state.probeMatches = false;
    if (gate === 'delta') f.state.deltaFresh = false;
    if (gate === 'path') f.state.pathDifferenceMs = null;
    if (gate === 'collection') f.measurement.start(0);
    if (gate === 'transaction') f.measurement.beginExternalRecalibration();
    f.alignment.reapplyBoot(0);
    assert.deepEqual(f.reapplied, []);
  });
}
