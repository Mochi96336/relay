import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { BootProbeRuntime, type BootProbeContext } from '../src/boot-probe-runtime.js';
import { CalibrationSession, type CalibrationContext } from '../src/calibration-session.js';
import { RobotContentTimelineMapper } from '../src/robot-content-timeline.js';

const RATE = 48_000;

function calibrationContext(): CalibrationContext {
  return {
    sessionGeneration: 1,
    micGeneration: 2,
    backingGeneration: 3,
    micSourceRate: 48_000,
    backingSourceRate: 48_000,
    sourceGeneration: 4,
  };
}

test('confirmed calibration authority is stale when only a capture source rate changes', () => {
  let context = calibrationContext();
  const calibration = new CalibrationSession({
    sampleRate: RATE,
    durationMs: 1_000,
    timeoutMs: 2_000,
    context: () => context,
  });

  calibration.applyExternalResult({ micLagMs: 250, confidence: 0.9 });
  assert.equal(calibration.isStaleFor(context), false);
  assert.equal(
    calibration.isStaleFor({ ...context, backingSourceRate: 44_100 }),
    true,
    'Backing generation reuse at a different source rate is a new timing context',
  );
  assert.equal(
    calibration.isStaleFor({ ...context, micSourceRate: 44_100 }),
    true,
    'Mic generation reuse at a different source rate is a new timing context',
  );

  context = { ...context, backingSourceRate: 44_100 };
  assert.equal(calibration.isStaleFor(context), true);
  assert.equal(
    calibration.confirmedResult?.micLagMs,
    250,
    'staleness preserves the confirmed result as history instead of deleting it',
  );
});

test('Boot probe provenance binds completed authority and Mic evidence to source-rate identity', () => {
  const context: BootProbeContext = {
    sessionGeneration: 10,
    micGeneration: 20,
    backingGeneration: 30,
    micSourceRate: 48_000,
    backingSourceRate: 48_000,
  };
  const probe = new BootProbeRuntime({ maxAttempts: 2, retryMs: 100 });
  probe.recordCalibration(context, {
    advanceMs: 420,
    micLatencyMs: 650,
    backingLatencyMs: 300,
    deltaMs: 70,
    confidence: 0.82,
  });

  assert.equal(probe.completedContextMatches(context), true);
  assert.equal(probe.completedContextMatches({ ...context, backingSourceRate: 44_100 }), false);
  assert.equal(probe.completedContextMatches({ ...context, micSourceRate: 44_100 }), false);

  probe.setMicLeg({
    targetSample: 1_000,
    actualSample: 1_120,
    correlation: 0.91,
    sessionGeneration: context.sessionGeneration,
    micGeneration: context.micGeneration,
    micSourceRate: context.micSourceRate,
  });
  assert.equal(probe.micLegStaleForContext(context), false);
  const sameMicDifferentBacking: BootProbeContext = {
    ...context,
    backingSourceRate: 44_100,
  };
  assert.equal(
    probe.micLegStaleForContext(sameMicDifferentBacking),
    false,
    'Backing clock changes do not invalidate independent Mic-leg evidence',
  );
  assert.equal(probe.micLegStaleForContext({
    sessionGeneration: context.sessionGeneration,
    micGeneration: context.micGeneration,
    micSourceRate: 44_100,
  }), true);
});

test('Robot content mapping rejects a rate-only capture-context change', () => {
  const context = calibrationContext();
  const mapper = new RobotContentTimelineMapper({ sampleRate: RATE, freshForMs: 1_000 });

  assert.equal(mapper.notePlayerOffset(120, context, 100), true);
  assert.equal(mapper.isReady(context, 100), true);
  assert.equal(mapper.isReady({ ...context, backingSourceRate: 44_100 }, 100), false);
  assert.equal(mapper.isReady({ ...context, micSourceRate: 44_100 }, 100), false);
});

test('production timing contexts and async context fences include capture source rates', () => {
  const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  const calibration = readFileSync(new URL('../src/calibration-session.ts', import.meta.url), 'utf8');
  const validator = readFileSync(new URL('../src/content-calibration-validator.ts', import.meta.url), 'utf8');
  const timeline = readFileSync(new URL('../src/robot-content-timeline.ts', import.meta.url), 'utf8');
  const transition = readFileSync(new URL('../src/robot-content-transition-runtime.ts', import.meta.url), 'utf8');

  assert.match(server, /function calibrationContext\(\)[\s\S]*micSourceRate: micRuntime\.sampleRate[\s\S]*backingSourceRate: backingRuntime\.sampleRate/);
  assert.match(server, /function bootProbeContext\(\)[\s\S]*micSourceRate: micRuntime\.sampleRate[\s\S]*backingSourceRate: backingRuntime\.sampleRate/);
  assert.match(server, /bootProbeRuntime\.setMicLeg\(\{[\s\S]*micSourceRate: micRuntime\.sampleRate/);
  assert.match(server, /bootProbeRuntime\.takeMicLegForContext\(\{\s*sessionGeneration: session\.generation,\s*micGeneration: session\.micGeneration,\s*micSourceRate: micRuntime\.sampleRate,\s*\}\)/);

  for (const [name, source] of [
    ['calibration', calibration],
    ['validator', validator],
    ['timeline', timeline],
    ['transition', transition],
  ] as const) {
    assert.match(source, /micSourceRate/, `${name} context equality must bind the Mic source rate`);
    assert.match(source, /backingSourceRate/, `${name} context equality must bind the Backing source rate`);
  }
});
