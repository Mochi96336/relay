import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CalibrationSession,
  type CalibrationContext,
  type CalibrationPassiveShadowObservation,
} from '../src/calibration-session.js';
import type {
  TimingCalibrationAnalysis,
  TimingCalibrationShadowAnalysis,
} from '../src/timing-calibration.js';

const RATE = 1_000;
const DURATION_MS = 1_000;
const WINDOW_SAMPLES = RATE;

function pcm(samples: number, value = 1000) {
  const output = new Int16Array(samples);
  output.fill(value);
  return output;
}

function analysis(lagMs = 285): TimingCalibrationAnalysis {
  return {
    micLagMs: lagMs,
    confidence: 0.8,
    segmentLagsMs: [lagMs, lagMs, lagMs, lagMs, lagMs],
    segmentCorrelations: [0.4, 0.41, 0.42, 0.43, 0.44],
    micLevelDbfs: -64,
    backingLevelDbfs: -20,
    diagnostics: {
      activeBands: [0, 1, 2, 3],
      supportingBands: [0, 1, 2, 3],
      bestLagMs: lagMs,
      bestScore: 0.42,
      runnerUpLagMs: lagMs + 500,
      runnerUpScore: 0.18,
      peakMargin: 0.24,
      localScores: [0.4, 0.41, 0.42, 0.43, 0.44],
    },
  };
}

function makeSession(
  context: CalibrationContext,
  observations: CalibrationPassiveShadowObservation[],
  analyze: NonNullable<ConstructorParameters<typeof CalibrationSession>[0]['analyze']>,
) {
  return new CalibrationSession({
    sampleRate: RATE,
    durationMs: DURATION_MS,
    timeoutMs: 5_000,
    context: () => context,
    analyze,
    passiveShadowEnabled: true,
    onPassiveShadow: (observation) => observations.push(observation),
  });
}

test('passive shadow analyzes PCM without starting a calibration transaction', () => {
  const context: CalibrationContext = {
    sessionGeneration: 1,
    micGeneration: 10,
    backingGeneration: 20,
    sourceGeneration: 0,
  };
  const observations: CalibrationPassiveShadowObservation[] = [];
  let analyzeCalls = 0;
  const session = makeSession(context, observations, () => {
    analyzeCalls += 1;
    return analysis();
  });

  session.observeMic(pcm(WINDOW_SAMPLES), 0);
  session.observeBacking(pcm(WINDOW_SAMPLES), 0);

  assert.equal(analyzeCalls, 1);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].authoritative, false);
  assert.equal(observations[0].strictPassed, true);
  assert.equal(observations[0].result?.micLagMs, 285);

  assert.equal(session.status().state, 'idle');
  assert.equal(session.result, null);
  assert.equal(session.confirmedResult, null);
  assert.equal(session.transactionActive, false);
});

test('source-generation movement invalidates a partial passive window', () => {
  const context: CalibrationContext = {
    sessionGeneration: 2,
    micGeneration: 30,
    backingGeneration: 40,
    sourceGeneration: 1,
  };
  const observations: CalibrationPassiveShadowObservation[] = [];
  let analyzeCalls = 0;
  const session = makeSession(context, observations, () => {
    analyzeCalls += 1;
    return analysis(320);
  });

  session.observeMic(pcm(500), 0);
  session.observeBacking(pcm(500), 0);

  context.sourceGeneration += 1;
  session.observeMic(pcm(500), 500);
  session.observeBacking(pcm(500), 500);

  assert.equal(analyzeCalls, 0, 'seek-before and seek-after PCM must not form one passive window');
  assert.equal(observations.length, 0);

  session.observeMic(pcm(500), 1_000);
  session.observeBacking(pcm(500), 1_000);

  assert.equal(analyzeCalls, 1);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].context.sourceGeneration, 2);
  assert.equal(observations[0].result?.micLagMs, 320);
  assert.equal(session.result, null);
});

test('capture-generation movement invalidates a partial passive window', () => {
  const context: CalibrationContext = {
    sessionGeneration: 3,
    micGeneration: 50,
    backingGeneration: 60,
    sourceGeneration: 0,
  };
  const observations: CalibrationPassiveShadowObservation[] = [];
  let analyzeCalls = 0;
  const session = makeSession(context, observations, () => {
    analyzeCalls += 1;
    return analysis(250);
  });

  session.observeMic(pcm(500), 0);
  session.observeBacking(pcm(500), 0);

  context.micGeneration = 51;
  session.observeMic(pcm(500), 500);
  session.observeBacking(pcm(500), 500);

  assert.equal(analyzeCalls, 0, 'old and new capture generations must not form one window');

  session.observeMic(pcm(500), 1_000);
  session.observeBacking(pcm(500), 1_000);

  assert.equal(analyzeCalls, 1);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].context.micGeneration, 51);
  assert.equal(session.result, null);
});

test('shadow recovery from the backing guard remains non-authoritative', async () => {
  const context: CalibrationContext = {
    sessionGeneration: 4,
    micGeneration: 70,
    backingGeneration: 80,
    sourceGeneration: 0,
  };
  const observations: CalibrationPassiveShadowObservation[] = [];
  const shadowResult = analysis(285);
  const shadow: TimingCalibrationShadowAnalysis = {
    reason: 'below-backing-level-floor',
    authoritative: false,
    micLevelDbfs: -30,
    backingLevelDbfs: -55,
    wouldPass: true,
    failureStage: null,
    error: null,
    result: {
      ...shadowResult,
      micLevelDbfs: -30,
      backingLevelDbfs: -55,
      diagnostics: shadowResult.diagnostics!,
    },
  };

  const session = makeSession(
    context,
    observations,
    (_mic, _backing, _rate, _maxLag, _signal, onShadow, shadowLowLevel) => {
      assert.equal(shadowLowLevel, true);
      onShadow?.(shadow);
      return Promise.reject(new Error('Desktop source is too quiet for timing calibration.'));
    },
  );

  session.observeMic(pcm(WINDOW_SAMPLES), 0);
  session.observeBacking(pcm(WINDOW_SAMPLES), 0);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(observations.length, 1);
  assert.equal(observations[0].strictPassed, false);
  assert.match(observations[0].error ?? '', /Desktop source is too quiet/i);
  assert.equal(observations[0].shadow?.wouldPass, true);
  assert.equal(observations[0].shadow?.result?.micLagMs, 285);

  assert.equal(session.status().state, 'idle');
  assert.equal(session.result, null);
  assert.equal(session.confirmedResult, null);
  assert.equal(session.transactionActive, false);
});
