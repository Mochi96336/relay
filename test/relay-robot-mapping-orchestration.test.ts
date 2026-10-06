import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { MAX_CAPTURE_GAP_MS, type CalibrationContext, type ConfirmedCalibrationResult } from '../src/calibration-session.js';
import { createRelayRobotMappingOrchestration, type RelayRobotMappingLifecycleDependencies } from '../src/relay-robot-mapping-orchestration.js';
import type { TimingWindow } from '../src/timing-window-collector.js';
import type { TimingRuntime } from '../src/timing-runtime.js';
import { functionCode, parseTypeScriptSource, variableInitializerCode } from './support/source-contract.js';

const SAMPLE_RATE = 48_000;
const HISTORY = SAMPLE_RATE * 3;

function evidence(length = SAMPLE_RATE + 1, gapSamples = 0): TimingWindow {
  return { mic: new Int16Array(length), backing: new Int16Array(length),
    originSample: 100, endSample: 100 + length, micGapSamples: gapSamples, backingGapSamples: 0 };
}

function fixture() {
  const calls: string[] = [];
  const context: CalibrationContext = {
    sessionGeneration: 3, micGeneration: 4, backingGeneration: 5,
    micSourceRate: SAMPLE_RATE, backingSourceRate: SAMPLE_RATE, sourceGeneration: 6,
  };
  const state = {
    robot: false, connected: false, connections: [] as boolean[],
    offset: 12 as number | null, fresh: true, ready: true, pendingBoundary: false,
    mapped: -123.5 as number | null,
    appliedKind: 'content' as ReturnType<TimingRuntime['appliedCalibrationKind']>,
    candidateKind: 'content' as 'content' | 'boot-probe',
    confirmed: { micLagMs: 14, confidence: 0.9, segmentLagsMs: [14] } as ConfirmedCalibrationResult | null,
    stale: false, collecting: false, evidence: evidence() as TimingWindow | null,
    throwAt: null as string | null,
  };
  const note = (label: string) => {
    calls.push(label);
    if (state.throwAt === label) throw new Error(label);
  };
  const unexpected = (): never => { throw new Error('a pure query must not issue a lifecycle command'); };
  const transition: RelayRobotMappingLifecycleDependencies<{ readyState: number }>['transition'] = {
    clear: unexpected, begin: unexpected, reconcileWithFreshDelta: unexpected,
    noteBackingFrame: unexpected, requestBackingBoundary: unexpected,
  };
  const deps = {
    socketOpenState: 1,
    mixSampleRate: SAMPLE_RATE,
    transitionHistorySamples: HISTORY,
    maxCaptureGapMs: MAX_CAPTURE_GAP_MS,
    backing: { get isRobot() { note('backing.robot'); return state.robot; }, socket: null, sampleRate: null },
    source: { connected() { note('source.connected'); return state.connections.shift() ?? state.connected; },
      invalidateMapping: unexpected, isActive: unexpected, detachRobot: unexpected },
    offset: {
      reset: unexpected,
      offsetMs(nowMs: number) { note(`offset.value:${nowMs}`); return state.offset; },
      isFresh(nowMs: number) { note(`offset.fresh:${nowMs}`); return state.fresh; },
    },
    timeline: {
      noteBackingBoundary: unexpected,
      reset: unexpected, matchesPlaybackRate: unexpected,
      committedDeltaMs: null, currentDeltaMs: null, referenceDeltaMs: null,
      isReady(actual: CalibrationContext, nowMs: number) {
        assert.equal(actual, context); note(`timeline.ready:${nowMs}`); return state.ready;
      },
      needsBackingBoundary(actual: CalibrationContext) {
        assert.equal(actual, context); note('timeline.boundary'); return state.pendingBoundary;
      },
      mapBackingStart(start: number, actual: CalibrationContext, nowMs: number) {
        assert.equal(actual, context); note(`timeline.map:${start}:${nowMs}`); return state.mapped;
      },
    },
    calibration: {
      restartWorkingEvidence: unexpected,
      discardPrimedContent: unexpected, fail: unexpected, reset: unexpected,
      get confirmedResult() { note('calibration.confirmed'); return state.confirmed; },
      get collecting() { note('calibration.collecting'); return state.collecting; },
      transitionEvidence(history: number) {
        assert.equal(history, HISTORY); note(`calibration.evidence:${history}`); return state.evidence;
      },
    },
    validator: { get collecting(): boolean { return unexpected(); }, cancel: unexpected },
    timing: { get calibrationKind() { note('timing.candidate'); return state.candidateKind; },
      clearCalibrationKind: unexpected, resetAutoCalibrationSchedule: unexpected },
    transition,
    mix: { backingGeneration: null, backingTotalSamples: 0,
      get active(): boolean { return unexpected(); } },
    take: { noteQualityEvent: unexpected },
    commands: { abandonProbeRun: unexpected },
    effects: { feedBackingEvidence: unexpected, clearContentValidation: unexpected, syncAppliedCalibration: unexpected,
      reportSourceStatus: unexpected, reportTimingStatus: unexpected, sendBoundaryRequest: unexpected,
      notifyPreviousReplaced: unexpected },
    queries: {
      currentPlaybackRate: unexpected,
      bootProbeSettled: unexpected,
      context() { note('context'); return context; },
      appliedKind() { note('timing.applied'); return state.appliedKind; },
      calibrationIsStale() { note('calibration.stale'); return state.stale; },
    },
  };
  return { calls, context, state, deps };
}

function mapping(f: ReturnType<typeof fixture>) {
  return createRelayRobotMappingOrchestration(f.deps);
}

for (const robot of [false, true]) {
  for (const connected of [false, true]) {
    test(`route is physical: backingRobot=${robot}, SourceConnected=${connected}`, () => {
      const f = fixture(); f.state.robot = robot; f.state.connected = connected;
      assert.equal(mapping(f).routeActive(), robot || connected);
      assert.deepEqual(f.calls, robot ? ['backing.robot'] : ['backing.robot', 'source.connected']);
    });
  }
}

test('delta freshness does not query or prune offset while Source is disconnected', () => {
  const f = fixture(); assert.equal(mapping(f).deltaFresh(123), false);
  assert.deepEqual(f.calls, ['source.connected']);
});
test('delta freshness queries offset before freshness and short-circuits a null offset', () => {
  const f = fixture(); f.state.connected = true; f.state.offset = null;
  assert.equal(mapping(f).deltaFresh(123), false);
  assert.deepEqual(f.calls, ['source.connected', 'offset.value:123']);
});
for (const fresh of [false, true]) {
  test(`delta freshness preserves offset housekeeping and the exact clock: fresh=${fresh}`, () => {
    const f = fixture(); f.state.connected = true; f.state.fresh = fresh; f.state.offset = 0;
    assert.equal(mapping(f).deltaFresh(123), fresh);
    assert.deepEqual(f.calls, ['source.connected', 'offset.value:123', 'offset.fresh:123']);
  });
}
test('non-Robot mapping readiness bypasses mapper/context queries', () => {
  const f = fixture(); f.state.ready = false;
  assert.equal(mapping(f).contentMappingReady(234), true);
  assert.deepEqual(f.calls, ['backing.robot', 'source.connected']);
});
test('Robot backing requires a connected Source before context/mapping readiness', () => {
  const f = fixture(); f.state.robot = true;
  assert.equal(mapping(f).contentMappingReady(234), false);
  assert.deepEqual(f.calls, ['backing.robot', 'source.connected']);
});
test('a Source-created route independently reads live Source connectivity again', () => {
  const f = fixture(); f.state.connections = [true, false];
  assert.equal(mapping(f).contentMappingReady(234), false);
  assert.deepEqual(f.calls, ['backing.robot', 'source.connected', 'source.connected']);
});
for (const ready of [false, true]) {
  test(`Robot mapping readiness preserves context identity/clock: ready=${ready}`, () => {
    const f = fixture(); f.state.robot = true; f.state.connected = true; f.state.ready = ready;
    assert.equal(mapping(f).contentMappingReady(234), ready);
    assert.deepEqual(f.calls, ['backing.robot', 'source.connected', 'context', 'timeline.ready:234']);
  });
}
test('evidence readiness never queries a boundary after failed mapping readiness', () => {
  const f = fixture(); f.state.robot = true;
  assert.equal(mapping(f).contentEvidenceReady(345), false);
  assert.deepEqual(f.calls, ['backing.robot', 'source.connected']);
});
for (const pendingBoundary of [false, true]) {
  test(`non-Robot evidence readiness still reads boundary/context: pending=${pendingBoundary}`, () => {
    const f = fixture(); f.state.pendingBoundary = pendingBoundary;
    assert.equal(mapping(f).contentEvidenceReady(345), !pendingBoundary);
    assert.deepEqual(f.calls, ['backing.robot', 'source.connected', 'context', 'timeline.boundary']);
  });
}
test('fresh Robot mapping is not evidence-ready until the pending PCM boundary commits', () => {
  const f = fixture(); f.state.robot = true; f.state.connected = true; f.state.pendingBoundary = true;
  assert.equal(mapping(f).contentMappingReady(345), true); f.calls.length = 0;
  assert.equal(mapping(f).contentEvidenceReady(345), false);
  assert.deepEqual(f.calls, ['backing.robot', 'source.connected', 'context', 'timeline.ready:345',
    'context', 'timeline.boundary']);
});
test('non-Robot backing keeps its original fractional coordinate, even on a Source route', () => {
  const f = fixture(); f.state.connected = true;
  assert.equal(mapping(f).mapBackingStart(-90.125, 456), -90.125);
  assert.deepEqual(f.calls, ['backing.robot']);
});
for (const mapped of [-123.5, null]) {
  test(`Robot backing delegates coordinate/context/clock and preserves mapped=${mapped}`, () => {
    const f = fixture(); f.state.robot = true; f.state.mapped = mapped;
    assert.equal(mapping(f).mapBackingStart(-90.125, 456), mapped);
    assert.deepEqual(f.calls, ['backing.robot', 'context', 'timeline.map:-90.125:456']);
  });
}
test('non-Robot follower seek preserves without asking timing/calibration policy', () => {
  const f = fixture(); assert.equal(mapping(f).followerSeekMayPreserveMapping(567), true);
  assert.deepEqual(f.calls, ['backing.robot', 'source.connected']);
});
test('Robot follower preservation rejects a disconnected Source before asking mapper/timing', () => {
  const f = fixture(); f.state.robot = true;
  assert.equal(mapping(f).followerSeekMayPreserveMapping(567), false);
  assert.deepEqual(f.calls, ['backing.robot', 'context', 'source.connected']);
});
test('Source-only follower preservation retains the two distinct connected queries', () => {
  const f = fixture(); f.state.connections = [true, false];
  assert.equal(mapping(f).followerSeekMayPreserveMapping(567), false);
  assert.deepEqual(f.calls, ['backing.robot', 'source.connected', 'context', 'source.connected']);
});
test('unready Robot mapping cannot preserve even confirmed content authority', () => {
  const f = fixture(); f.state.robot = true; f.state.connected = true; f.state.ready = false;
  assert.equal(mapping(f).followerSeekMayPreserveMapping(567), false);
  assert.deepEqual(f.calls, ['backing.robot', 'context', 'source.connected', 'timeline.ready:567']);
});
const preserveReadyTrace = ['backing.robot', 'context', 'source.connected', 'timeline.ready:567'];
test('confirmed applied content preserves even during boot candidate and a pending boundary', () => {
  const f = fixture(); f.state.robot = true; f.state.connected = true;
  f.state.candidateKind = 'boot-probe'; f.state.pendingBoundary = true;
  assert.equal(mapping(f).followerSeekMayPreserveMapping(567), true);
  assert.deepEqual(f.calls, [...preserveReadyTrace, 'timing.applied', 'calibration.confirmed', 'calibration.stale']);
});
test('confirmed boot authority is not attributed to a collecting content candidate', () => {
  const f = fixture(); f.state.robot = true; f.state.connected = true;
  f.state.appliedKind = 'boot-probe'; f.state.collecting = true; f.state.evidence = null;
  assert.equal(mapping(f).followerSeekMayPreserveMapping(567), false);
  assert.deepEqual(f.calls, [...preserveReadyTrace, 'timing.applied', 'timing.candidate',
    'calibration.collecting', `calibration.evidence:${HISTORY}`]);
});
test('a content authority with no confirmed result must use the candidate evidence gate', () => {
  const f = fixture(); f.state.robot = true; f.state.connected = true; f.state.confirmed = null;
  assert.equal(mapping(f).followerSeekMayPreserveMapping(567), false);
  assert.deepEqual(f.calls, [...preserveReadyTrace, 'timing.applied', 'calibration.confirmed',
    'timing.candidate', 'calibration.collecting']);
});
test('stale content authority does not bypass a non-content candidate', () => {
  const f = fixture(); f.state.robot = true; f.state.connected = true; f.state.stale = true;
  f.state.candidateKind = 'boot-probe'; f.state.collecting = true;
  assert.equal(mapping(f).followerSeekMayPreserveMapping(567), false);
  assert.deepEqual(f.calls, [...preserveReadyTrace, 'timing.applied', 'calibration.confirmed',
    'calibration.stale', 'timing.candidate']);
});
for (const [label, window, expected] of [
  ['no shared window', null, false],
  ['exactly one second is insufficient', evidence(SAMPLE_RATE), false],
  ['common PCM longer than one second', evidence(), true],
  ['maximum permitted gap', evidence(HISTORY, 14_400), true],
  ['one sample beyond maximum gap', evidence(HISTORY, 14_401), false],
  ['mostly empty span', evidence(HISTORY, HISTORY - 1), false],
] as const) {
  test(`collecting content preservation delegates the existing evidence policy: ${label}`, () => {
    const f = fixture(); f.state.robot = true; f.state.connected = true;
    f.state.appliedKind = 'none'; f.state.collecting = true; f.state.evidence = window;
    assert.equal(mapping(f).followerSeekMayPreserveMapping(567), expected);
    assert.deepEqual(f.calls, [...preserveReadyTrace, 'timing.applied', 'timing.candidate',
      'calibration.collecting', `calibration.evidence:${HISTORY}`]);
  });
}
test('each invocation reads live truth and the caller-supplied clock rather than cached facts', () => {
  const f = fixture(); const owner = mapping(f);
  assert.equal(owner.routeActive(), false); f.state.robot = true;
  assert.equal(owner.routeActive(), true); f.state.connected = true;
  assert.equal(owner.deltaFresh(10), true); f.state.offset = null;
  assert.equal(owner.deltaFresh(11), false);
  assert.deepEqual(f.calls, ['backing.robot', 'source.connected', 'backing.robot',
    'source.connected', 'offset.value:10', 'offset.fresh:10', 'source.connected', 'offset.value:11']);
});
test('query exceptions remain synchronous and are not swallowed or followed by more queries', () => {
  const f = fixture(); f.state.connected = true; f.state.throwAt = 'offset.value:678';
  assert.throws(() => mapping(f).deltaFresh(678), /offset.value:678/);
  assert.deepEqual(f.calls, ['source.connected', 'offset.value:678']);
});

test('construction does not query authority, housekeeping or calibration context', () => {
  const f = fixture(); mapping(f);
  assert.equal(f.calls.length, 0);
});

test('production binds canonical owners and live queries after domain construction', () => {
  const text = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  const server = parseTypeScriptSource(new URL('../src/server.ts', import.meta.url), text);
  const composition = variableInitializerCode(server, 'relayRobotMapping');
  assert.match(composition, /^createRelayRobotMappingOrchestration\(\{/);
  for (const binding of [
    'mixSampleRate: MIX_SAMPLE_RATE', 'transitionHistorySamples: ROBOT_CONTENT_TRANSITION_HISTORY_SAMPLES',
    'maxCaptureGapMs: MAX_CAPTURE_GAP_MS', 'backing: backingRuntime', 'source: sourceRuntime',
    'offset: robotPlayerOffset', 'timeline: robotContentTimeline', 'calibration,', 'timing: timingRuntime',
    'context: calibrationContext', 'appliedKind: appliedCalibrationKind', 'calibrationIsStale,',
  ]) assert.ok(composition.includes(binding), `production binding ${binding}`);
  const initialized = text.indexOf('const relayRobotMapping =');
  assert.ok(initialized > text.indexOf('const calibration = new CalibrationSession('));
  assert.ok(initialized > text.indexOf('const contentCalibrationValidator = new ContentCalibrationValidator('));
  assert.doesNotMatch(composition, /PROBE_CALIBRATE|setInterval|setTimeout/);
  const mapping = parseTypeScriptSource(new URL('../src/relay-robot-mapping-orchestration.ts', import.meta.url),
    readFileSync(new URL('../src/relay-robot-mapping-orchestration.ts', import.meta.url), 'utf8'));
  assert.doesNotMatch(functionCode(mapping, 'createRobotMappingQueries'), /syncAppliedCalibration/,
    'query collection cannot settle calibration; the shared lifecycle may bind its explicit command port');
});

test('all six production wrappers retain defaults and delegate without duplicate policy', () => {
  const server = parseTypeScriptSource(new URL('../src/server.ts', import.meta.url),
    readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'));
  for (const [wrapper, signature, method, args] of [
    ['robotRouteActive', '', 'routeActive', ''],
    ['robotDeltaIsFresh', 'nowMs = performance.now()', 'deltaFresh', 'nowMs'],
    ['robotContentMappingReady', 'nowMs = performance.now()', 'contentMappingReady', 'nowMs'],
    ['robotContentEvidenceMappingReady', 'nowMs = performance.now()', 'contentEvidenceReady', 'nowMs'],
    ['mappedContentBackingStart', 'startSample: number, nowMs = performance.now()', 'mapBackingStart', 'startSample, nowMs'],
    ['robotFollowerSeekMayPreserveMapping', 'nowMs = performance.now()', 'followerSeekMayPreserveMapping', 'nowMs'],
  ]) {
    assert.equal(functionCode(server, wrapper).replace(/\s+/g, ' ').trim(),
      `function ${wrapper}(${signature}) { return relayRobotMapping.${method}(${args}); }`);
  }
});
