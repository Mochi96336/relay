import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { AudioSession } from '../src/audio-session.js';
import { autoContentCalibrationAuthorityAllowsStart, autoContentCalibrationPrerequisitesReady } from '../src/auto-content-calibration-policy.js';
import { combineBootCalibration } from '../src/boot-calibration.js';
import { decideBootProbeAnalysisEvidence } from '../src/boot-probe-analysis-evidence-policy.js';
import { decideBootProbeAnalysisReadiness } from '../src/boot-probe-analysis-readiness-policy.js';
import { decideBootProbeReapplication } from '../src/boot-probe-reapplication.js';
import { decideBootProbeRunIdentity } from '../src/boot-probe-run-identity-policy.js';
import { BootProbeRuntime, type BootProbeContext } from '../src/boot-probe-runtime.js';
import { decideBootProbeMixerApplication } from '../src/boot-probe-mixer-application.js';
import { bootProbeStartAuthorityAllowsAttempt, selectBootProbeStartTarget } from '../src/boot-probe-start-policy.js';
import { bootProbeTopologyReady } from '../src/boot-probe-topology-admission-policy.js';
import { generateProbeReference, locateProbe, PROBE_REFERENCE_MS } from '../src/calibration-probe.js';
import { decideCalibrationApplicability } from '../src/calibration-applicability.js';
import { decideCalibrationMixerApplication } from '../src/calibration-mixer-application.js';
import { CalibrationSession, type CalibrationContext } from '../src/calibration-session.js';
import type { ProbeTarget } from '../src/probe-lifecycle.js';
import { createRelayBootProbeCalibrationPromotionCoordinator } from '../src/relay-boot-probe-calibration-promotion-coordinator.js';
import { createRelayBootProbeFailureSettlementCoordinator } from '../src/relay-boot-probe-failure-settlement-coordinator.js';
import { createRelayBootProbeOrchestration, type RelayBootProbeDependencies } from '../src/relay-boot-probe-orchestration.js';
import { createRelayManualBootRecalibrationCoordinator } from '../src/relay-manual-boot-recalibration-coordinator.js';
import { RobotContentTimelineMapper } from '../src/robot-content-timeline.js';
import type { TimingCalibrationAnalysis } from '../src/timing-calibration.js';
import { TimingRuntime, type TimingCalibrationKind } from '../src/timing-runtime.js';
import { functionCode, hasFunction, importSources, parseTypeScriptSource, sourceCode, variableInitializerCode } from './support/source-contract.js';

type Reply = { requestId: unknown; generation: unknown };
type Workflow = {
  context(): BootProbeContext;
  stepAdmission(nowMs: number): void;
  stepAnalysis(nowMs: number): void;
  stepReapply(nowMs: number): void;
  handleReply(reply: Reply, nowMs: number): void;
  handleFailure(reply: Reply & { reason: unknown }, nowMs: number): void;
  failAttempt(target: ProbeTarget, reason: string, nowMs: number): void;
  abandon(): void;
};

// C0's original adapter and all fixed oracles are archived before replacing
// only the workflow entry below. Application algorithms now have their S22 owner.
const server = parseTypeScriptSource(
  new URL('../src/server.ts', import.meta.url),
  readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'),
);
const applicationOwner = parseTypeScriptSource(
  new URL('../src/relay-calibration-orchestration.ts', import.meta.url),
  readFileSync(new URL('../src/relay-calibration-orchestration.ts', import.meta.url), 'utf8'),
);
type Ports = RelayBootProbeDependencies<object>;

test('production boot workflow binds exactly the canonical owners, live queries and original effects', () => {
  assert.equal(importSources(server).filter(path => path === './relay-boot-probe-orchestration.js').length, 1);
  const composition = variableInitializerCode(server, 'relayBootProbe').replace(/\s/g, '');
  assert.equal(composition, `createRelayBootProbeOrchestration({
    config: { sampleRate: MIX_SAMPLE_RATE, leadMs: PROBE_LEAD_MS,
      searchMarginMs: PROBE_SEARCH_MARGIN_MS, referenceMs: PROBE_REFERENCE_MS,
      analysisTimeoutMs: PROBE_ANALYSIS_TIMEOUT_MS, minCorrelation: PROBE_MIN_CORRELATION,
      maxCaptureGapMs: MAX_CAPTURE_GAP_MS, reapplyThresholdMs: BOOT_DELTA_REAPPLY_MS,
      debug: PROBE_DEBUG, },
    mix: session, mic: micRuntime, backing: backingRuntime, source: sourceRuntime,
    probe: bootProbeRuntime, calibration, timing: timingRuntime,
    queries: { robotRouteActive, robotProbeTimingActive, takeBlocksCalibration,
      micPlayable, backingPlayable, calibrationIsStale, probeStatus,
      appliedCalibrationKind, calibrationApplicability, roomHasSong, robotDeltaIsFresh,
      currentDeltaMs, currentPlaybackRate, bootProbeAdvanceMs, },
    effects: { sendProbe: (target, message) => sendJson(target, message),
      reportTimingStatus: () => broadcastJson(timingCalibrationStatusPayload()),
      debugLog: (message) => console.log(message), },
  })`.replace(/\s/g, ''));
  const code = sourceCode(server);
  assert.equal(Array.from(code.matchAll(/createRelayBootProbeOrchestration\(/g)).length, 1);
  const construction = code.indexOf('const relayBootProbe =');
  for (const name of ['session', 'micRuntime', 'backingRuntime', 'sourceRuntime',
    'bootProbeRuntime', 'calibration', 'timingRuntime']) {
    const declaration = code.indexOf(`const ${name} =`);
    assert.ok(declaration >= 0 && declaration < construction, `${name} exists before composition`);
  }
  assert.ok(code.indexOf('relayMixPump.start();') < construction);
  assert.ok(construction < code.indexOf('const youtubeTimelineTimer ='));
  assert.doesNotMatch(code.slice(0, construction), /\bawait\b/);
});

test('production boot entry points delegate once and no private algorithm or coordinator remains in server', () => {
  for (const [name, call] of [
    ['bootProbeContext', 'return relayBootProbe.context();'],
    ['abandonProbeRun', 'relayBootProbe.abandon();'],
    ['failProbeAttempt', 'relayBootProbe.failAttempt(target, reason, nowMs);'],
    ['maybeStartProbeCalibration', 'relayBootProbe.stepAdmission(nowMs);'],
    ['maybeFinishProbeAnalysis', 'relayBootProbe.stepAnalysis(nowMs);'],
    ['maybeReapplyBootCalibration', 'relayBootProbe.stepReapply(nowMs);'],
    ['handleProbeReply', 'relayBootProbe.handleReply(reply, nowMs);'],
    ['handleProbeFailure', 'relayBootProbe.handleFailure(reply, nowMs);'],
  ]) {
    const declaration = functionCode(server, name);
    const body = declaration.match(/\)\s*\{\s*((?:return )?relayBootProbe\.[^;]+;)\s*\}$/)?.[1];
    assert.equal(body, call, `${name} is only its true caller's synchronous forwarding seam`);
  }
  for (const name of ['probeGeneration', 'probePathReady', 'sendProbeRequest',
    'acceptCurrentProbeClientResult', 'promoteBootProbeCalibration']) {
    assert.equal(hasFunction(server, name), false, `${name} must have one algorithm owner`);
  }
  assert.doesNotMatch(sourceCode(server), /createRelayBootProbe(?:FailureSettlement|CalibrationPromotion)Coordinator/);
  const lifecycle = parseTypeScriptSource(new URL('../src/relay-calibration-orchestration.ts', import.meta.url),
    readFileSync(new URL('../src/relay-calibration-orchestration.ts', import.meta.url), 'utf8'));
  assert.match(functionCode(lifecycle, 'clearBootCalibrationState'), /bootProbeRuntime\.clear\(\)/);
  assert.doesNotMatch(functionCode(lifecycle, 'clearBootCalibrationState'), /relayBootProbe\.abandon/);
  assert.equal(hasFunction(server, 'clearBootCalibrationState'), false, 'both true callers moved into lifecycle');
  assert.match(variableInitializerCode(server, 'relayCalibrationLifecycle'), /probe: bootProbeRuntime/);
});

test('production timing tick retains expiry, settlement, analysis, admission and reapply on its original clock', () => {
  const tick = variableInitializerCode(server, 'youtubeTimelineTimer');
  const markers = [
    'const nowMs = performance.now();', 'relaySongCommands.stepExpiry(nowMs)',
    'if (calibration.collecting)', 'if (session.active &&',
    'bootProbeRuntime.takeExpiredRequest(nowMs, PROBE_REPLY_TIMEOUT_MS)',
    "failProbeAttempt(expiredProbe.target, 'playback acknowledgement timed out', nowMs)",
    'dropLegacyCalibrationForRobot()', 'if (syncAppliedCalibration())',
    'maybeFinishProbeAnalysis(nowMs)', 'maybeStartProbeCalibration(nowMs)',
    'maybeReapplyBootCalibration(nowMs)', 'sweepRobotContentTransition(nowMs)',
    'maybeAutoCalibrate(nowMs)', 'maybeValidateContentCalibration(nowMs)',
    'sweepPreparedSongHandoff(nowMs)', 'participants.sweep(Date.now())', 'broadcastProductStatus(nowMs)',
  ];
  let previous = -1;
  for (const marker of markers) {
    const index = tick.indexOf(marker);
    assert.ok(index > previous, `${marker} must exist in the original tick order`);
    previous = index;
  }
  assert.equal(Array.from(tick.matchAll(/performance\.now\(\)/g)).length, 1);
  assert.match(tick, /\}, TIMELINE_STATUS_REFRESH_MS\)$/);
  assert.match(sourceCode(server), /const TIMELINE_STATUS_REFRESH_MS = 250;/);
  assert.match(variableInitializerCode(server, 'relaySongCommands'), /commands: roomSongCommands/);
  const song = parseTypeScriptSource(new URL('../src/relay-song-orchestration.ts', import.meta.url),
    readFileSync(new URL('../src/relay-song-orchestration.ts', import.meta.url), 'utf8'));
  assert.match(functionCode(song, 'stepExpiry'), /commands\.sweep\(nowMs\)/);
});

test('boot workflow adds no scheduler, async boundary or second domain owner', () => {
  const workflow = parseTypeScriptSource(new URL('../src/relay-boot-probe-orchestration.ts', import.meta.url),
    readFileSync(new URL('../src/relay-boot-probe-orchestration.ts', import.meta.url), 'utf8'));
  assert.doesNotMatch(sourceCode(workflow), /\b(?:setInterval|setTimeout|queueMicrotask|async|await)\b|new (?:BootProbeRuntime|CalibrationSession|TimingRuntime|AudioSession|Map|WeakMap)\b/);
});

type WorkflowInput = Ports['queries'] & {
  session: Ports['mix']; micRuntime: Ports['mic']; backingRuntime: Ports['backing'];
  sourceRuntime: Ports['source']; bootProbeRuntime: Ports['probe'];
  calibration: Ports['calibration']; timingRuntime: Ports['timing'];
  MIX_SAMPLE_RATE: number; PROBE_LEAD_MS: number; PROBE_SEARCH_MARGIN_MS: number;
  PROBE_REFERENCE_MS: number; PROBE_ANALYSIS_TIMEOUT_MS: number; PROBE_MIN_CORRELATION: number;
  MAX_CAPTURE_GAP_MS: number; BOOT_DELTA_REAPPLY_MS: number; PROBE_DEBUG: boolean;
  sendJson: Ports['effects']['sendProbe'];
  timingCalibrationStatusPayload(): object;
  broadcastJson(payload: object): void;
  console: { log(message: string): void };
};

function workflowFromPorts(d: WorkflowInput): Workflow {
  return createRelayBootProbeOrchestration({
    config: { sampleRate: d.MIX_SAMPLE_RATE, leadMs: d.PROBE_LEAD_MS,
      searchMarginMs: d.PROBE_SEARCH_MARGIN_MS, referenceMs: d.PROBE_REFERENCE_MS,
      analysisTimeoutMs: d.PROBE_ANALYSIS_TIMEOUT_MS, minCorrelation: d.PROBE_MIN_CORRELATION,
      maxCaptureGapMs: d.MAX_CAPTURE_GAP_MS, reapplyThresholdMs: d.BOOT_DELTA_REAPPLY_MS,
      debug: d.PROBE_DEBUG },
    mix: d.session, mic: d.micRuntime, backing: d.backingRuntime, source: d.sourceRuntime,
    probe: d.bootProbeRuntime, calibration: d.calibration, timing: d.timingRuntime,
    queries: { robotRouteActive: () => d.robotRouteActive(),
      robotProbeTimingActive: () => d.robotProbeTimingActive(),
      takeBlocksCalibration: () => d.takeBlocksCalibration(),
      micPlayable: now => d.micPlayable(now), backingPlayable: now => d.backingPlayable(now),
      calibrationIsStale: () => d.calibrationIsStale(), probeStatus: now => d.probeStatus(now),
      appliedCalibrationKind: () => d.appliedCalibrationKind(),
      calibrationApplicability: kind => d.calibrationApplicability(kind),
      roomHasSong: now => d.roomHasSong(now), robotDeltaIsFresh: now => d.robotDeltaIsFresh(now),
      currentDeltaMs: now => d.currentDeltaMs(now), currentPlaybackRate: now => d.currentPlaybackRate(now),
      bootProbeAdvanceMs: now => d.bootProbeAdvanceMs(now) },
    effects: { sendProbe: (target, message) => d.sendJson(target, message),
      reportTimingStatus: () => d.broadcastJson(d.timingCalibrationStatusPayload()),
      debugLog: message => d.console.log(message) },
  });
}

test('boot workflow construction performs no owner reads, commands, publications or scheduling', () => {
  const f = fixture();
  const poison = <T extends object>(owner: T): T => new Proxy(owner, {
    get(_target, property) { throw new Error(`constructor queried ${String(property)}`); },
  });
  const owner = workflowFromPorts({ ...f.dependencies,
    session: poison(f.mix), micRuntime: poison(f.mic), backingRuntime: poison(f.backing),
    sourceRuntime: poison(f.source), bootProbeRuntime: poison(f.probe),
    calibration: poison(f.calibration), timingRuntime: poison(f.timing) });
  assert.deepEqual(Object.keys(owner).sort(), ['abandon', 'context', 'failAttempt',
    'handleFailure', 'handleReply', 'stepAdmission', 'stepAnalysis', 'stepReapply']);
  assert.equal(f.events.length, 0);
  assert.equal(f.messages.length, 0);
});

type Topology = {
  mic: boolean;
  backing: boolean;
  robot: boolean;
  flag: boolean;
  take: 'idle' | 'recording' | 'finalizing';
};

function fixture(topology: Partial<Topology> = {}, debug = false) {
  const facts: Topology = { mic: true, backing: true, robot: true, flag: true, take: 'idle', ...topology };
  const events: string[] = [];
  const messages: Array<{ target: object; payload: Record<string, unknown> }> = [];
  const control = {
    stale: false, appliedKind: 'none' as TimingCalibrationKind,
    applicability: 'revoke' as 'apply' | 'hold' | 'revoke', song: true,
    deltaFresh: true, advance: null as number | null, delta: 100, rate: 2,
    throwAt: null as string | null,
  };
  const note = (event: string) => {
    events.push(event);
    if (control.throwAt === event) throw new Error(event);
  };
  const probe = new BootProbeRuntime({ maxAttempts: 2, retryMs: 100 });
  const timing = new TimingRuntime({ autoCalibrationRetryMs: 100 });
  const publisher = { role: 'mic' };
  const sourceSocket = { role: 'source' };
  const mix = {
    active: true,
    generation: 1,
    micGeneration: 2 as number | null,
    backingGeneration: 3 as number | null,
    micTotalSamples: 0,
    backingTotalSamples: 0,
    alignment: { calibratedMicLagMs: null as number | null },
    sessionSampleAt(nowMs: number) { events.push(`sample-at:${nowMs}`); return nowMs * 48; },
    readMicEvidence() { events.push('mic-evidence'); return { gapSamples: 0, frontierMissingSamples: 0 }; },
    readBackingEvidence() { events.push('backing-evidence'); return { gapSamples: 0, frontierMissingSamples: 0 }; },
    readMic(_start: number, count: number) { events.push('mic-pcm'); return new Int16Array(count); },
    readBacking(_start: number, count: number) { events.push('backing-pcm'); return new Int16Array(count); },
  };
  const calibration = {
    collecting: false,
    transactionActive: false,
    result: null as { micLagMs: number; confidence: number } | null,
    confirmedRevision: 0,
    failPreservingPrimed(reason: string) {
      events.push(`fail:${reason}`);
      this.transactionActive = false;
    },
    applyExternalResult(result: { micLagMs: number; confidence: number }) {
      events.push('apply');
      this.result = result;
      this.confirmedRevision += 1;
      mix.alignment.calibratedMicLagMs = result.micLagMs;
    },
  };
  const mic = {
    sampleRate: 48_000,
    publisher,
    controlConnected() { events.push('mic-control'); return facts.mic; },
  };
  const backing = {
    sampleRate: 48_000,
    get isRobot() { events.push('backing-robot'); return facts.backing && facts.robot; },
    connected() { events.push('backing-connected'); return facts.backing; },
  };
  const source = {
    connected() { events.push('source-connected'); return facts.robot; },
    get socket() { events.push('source-socket'); return facts.robot ? sourceSocket : null; },
  };
  const dependencies = {
    session: mix, micRuntime: mic, backingRuntime: backing, sourceRuntime: source,
    calibration, timingRuntime: timing, bootProbeRuntime: probe,
    createRelayBootProbeFailureSettlementCoordinator,
    createRelayBootProbeCalibrationPromotionCoordinator,
    bootProbeTopologyReady, bootProbeStartAuthorityAllowsAttempt, selectBootProbeStartTarget,
    decideBootProbeRunIdentity, decideBootProbeAnalysisReadiness, decideBootProbeAnalysisEvidence,
    decideBootProbeReapplication, locateProbe, combineBootCalibration,
    MIX_SAMPLE_RATE: 48_000, PROBE_REFERENCE_MS, PROBE_LEAD_MS: 250,
    PROBE_SEARCH_MARGIN_MS: 1_000, PROBE_ANALYSIS_TIMEOUT_MS: 10_000,
    PROBE_MIN_CORRELATION: 0.5, MAX_CAPTURE_GAP_MS: 300, BOOT_DELTA_REAPPLY_MS: 50,
    PROBE_DEBUG: debug,
    console: { log(message: string) { note(`debug:${message}`); } },
    robotRouteActive() { events.push('route'); return backing.isRobot || source.connected(); },
    robotProbeTimingActive() { events.push('strategy'); return facts.flag && (backing.isRobot || source.connected()); },
    takeBlocksCalibration() { events.push('take'); return facts.take !== 'idle'; },
    micPlayable(nowMs: number) { events.push(`mic-playable:${nowMs}`); return facts.mic; },
    backingPlayable(nowMs: number) { events.push(`backing-playable:${nowMs}`); return facts.backing; },
    calibrationIsStale() { note('stale'); return control.stale; },
    probeStatus(nowMs: number) { events.push(`probe-status:${nowMs}`); return probe.status(nowMs); },
    timingCalibrationStatusPayload() { note('timing-payload'); return { type: 'timing' }; },
    broadcastJson() { note('publish-timing'); },
    sendJson(target: object, payload: Record<string, unknown>) {
      note(`send:${payload.target}`);
      messages.push({ target, payload });
    },
    currentDeltaMs() { note('delta'); return control.delta; },
    currentPlaybackRate() { note('rate'); return control.rate; },
    appliedCalibrationKind() { note('applied-kind'); return control.appliedKind; },
    calibrationApplicability() { note('applicability'); return control.applicability; },
    roomHasSong() { note('song'); return control.song; },
    robotDeltaIsFresh() { note('delta-fresh'); return control.deltaFresh; },
    bootProbeAdvanceMs() { note('advance'); return control.advance; },
  };
  return { facts, events, messages, probe, timing, mix, calibration, mic, backing, source,
    publisher, sourceSocket, control, dependencies, workflow: workflowFromPorts(dependencies) };
}

for (const mic of [false, true]) for (const backing of [false, true]) {
  for (const robot of [false, true]) for (const flag of [false, true]) {
    for (const take of ['idle', 'recording', 'finalizing'] as const) {
      test(`old boot admission topology mic=${mic} backing=${backing} robot=${robot} flag=${flag} take=${take}`, () => {
        const f = fixture({ mic, backing, robot, flag, take });
        f.workflow.stepAdmission(1_000);
        const admitted = mic && backing && robot && flag && take === 'idle';
        assert.equal(f.messages.length, admitted ? 1 : 0);
        assert.equal(f.probe.status(1_000).phase, admitted ? 'mic-requested' : 'idle');
        assert.equal(f.probe.status(1_000).attempts.mic, admitted ? 1 : 0);
        assert.equal(f.calibration.confirmedRevision, 0);
        assert.equal(f.mix.alignment.calibratedMicLagMs, null);
        if (!admitted) {
          assert.equal(f.events.includes('publish-timing'), false);
          return;
        }
        assert.equal(f.messages[0].target, f.publisher);
        assert.deepEqual(f.messages[0].payload, {
          type: 'play-calibration-probe', target: 'mic', requestId: 1, leadMs: 250,
        });
        f.workflow.handleFailure({ requestId: 1, generation: 2, reason: ' first ' }, 1_010);
        assert.equal(f.probe.status(1_010).phase, 'mic-retry-wait');
        f.workflow.stepAdmission(1_109);
        assert.equal(f.messages.length, 1, 'retry cannot precede the owner deadline');
        f.workflow.stepAdmission(1_110);
        assert.equal(f.messages.length, 2);
        f.workflow.handleFailure({ requestId: 2, generation: 2, reason: ' second ' }, 1_120);
        assert.equal(f.probe.status(1_120).phase, 'failed');
        assert.equal(f.probe.status(1_120).active, false);
        assert.equal(f.probe.status(1_120).attempts.mic, 2);
        assert.equal(f.events.at(-1), 'fail:Microphone timing probe failed after 2 attempts: second');
        f.workflow.stepAdmission(2_000);
        assert.equal(f.messages.length, 2, 'terminal failure spends no further attempt');
      });
    }
  }
}

test('old boot context preserves capture rates but excludes Source mapping identity', () => {
  const f = fixture();
  assert.deepEqual(f.workflow.context(), {
    sessionGeneration: 1, micGeneration: 2, backingGeneration: 3,
    micSourceRate: 48_000, backingSourceRate: 48_000,
  });
  f.mic.sampleRate = 44_100;
  f.mix.backingGeneration = 4;
  assert.deepEqual(f.workflow.context(), {
    sessionGeneration: 1, micGeneration: 2, backingGeneration: 4,
    micSourceRate: 44_100, backingSourceRate: 48_000,
  });
});

for (const reply of [{ requestId: 999, generation: 2 }, { requestId: 1, generation: 999 }]) {
  test(`old wrong client identity leaves the authoritative request usable: ${JSON.stringify(reply)}`, () => {
    const f = fixture();
    f.workflow.stepAdmission(1_000);
    f.events.length = 0;
    f.workflow.handleReply(reply, 1_020);
    assert.deepEqual(f.events, []);
    assert.equal(f.probe.status(1_020).phase, 'mic-requested');
    assert.equal(f.calibration.confirmedRevision, 0);
    assert.equal(f.mix.alignment.calibratedMicLagMs, null);
    f.workflow.handleReply({ requestId: 1, generation: 2 }, 1_020);
    assert.deepEqual(f.probe.pendingAnalysis, {
      target: 'mic', targetSample: 60_480, windowStart: 54_480, windowSamples: 70_560,
      sessionGeneration: 1, generation: 2, deadlineMs: 11_020,
    });
    assert.deepEqual(f.events, ['sample-at:1260', 'timing-payload', 'publish-timing']);
  });
}

for (const change of ['inactive', 'session', 'capture'] as const) {
  test(`old accepted reply with changed server ${change} abandons without spending a failure`, () => {
    const f = fixture();
    f.workflow.stepAdmission(1_000);
    if (change === 'inactive') f.mix.active = false;
    if (change === 'session') f.mix.generation += 1;
    if (change === 'capture') f.mix.micGeneration = 9;
    f.events.length = 0;
    f.workflow.handleReply({ requestId: 1, generation: 2 }, 1_020);
    assert.deepEqual(f.events, ['timing-payload', 'publish-timing']);
    assert.equal(f.probe.pendingAnalysis, null);
    assert.equal(f.probe.status(1_020).phase, 'idle');
    assert.deepEqual(f.probe.status(1_020).attempts, { mic: 0, backing: 0 });
    assert.equal(f.calibration.confirmedRevision, 0);
    assert.equal(f.mix.alignment.calibratedMicLagMs, null);
  });
}

test('old abandon keeps request ids monotonic and a previous reply cannot consume the successor', () => {
  const f = fixture();
  f.workflow.stepAdmission(1_000);
  f.workflow.abandon();
  f.workflow.stepAdmission(2_000);
  assert.equal(f.messages[1].payload.requestId, 2);
  f.events.length = 0;
  f.workflow.handleFailure({ requestId: 1, generation: 2, reason: 'late failure' }, 2_020);
  assert.deepEqual(f.events, []);
  assert.equal(f.probe.status(2_020).phase, 'mic-requested');
  f.workflow.handleReply({ requestId: 2, generation: 2 }, 2_020);
  assert.equal(f.probe.pendingAnalysis?.targetSample, 108_480);
  assert.equal(f.calibration.confirmedRevision, 0);
  assert.equal(f.mix.alignment.calibratedMicLagMs, null);
});

test('old outer expiry equality is accepted and a consumed expired reply cannot start analysis', () => {
  const f = fixture();
  f.workflow.stepAdmission(1_000);
  assert.equal(f.probe.takeExpiredRequest(2_000, 1_000), null);
  const expired = f.probe.takeExpiredRequest(2_001, 1_000);
  assert.equal(expired?.requestId, 1);
  f.workflow.failAttempt('mic', 'playback acknowledgement timed out', 2_001);
  f.events.length = 0;
  f.workflow.handleReply({ requestId: 1, generation: 2 }, 2_002);
  assert.deepEqual(f.events, []);
  assert.equal(f.probe.pendingAnalysis, null);
  assert.equal(f.probe.status(2_002).phase, 'mic-retry-wait');
  assert.equal(f.calibration.confirmedRevision, 0);
  assert.equal(f.mix.alignment.calibratedMicLagMs, null);
});

function pendingMicAnalysis() {
  const f = fixture();
  f.workflow.stepAdmission(1_000);
  f.workflow.handleReply({ requestId: 1, generation: 2 }, 1_020);
  const pending = f.probe.pendingAnalysis;
  assert.ok(pending);
  f.events.length = 0;
  return { ...f, pending };
}

for (const change of ['inactive', 'session', 'capture'] as const) {
  test(`old analysis ${change} fence beats timeout and a reached PCM window`, () => {
    const f = pendingMicAnalysis();
    f.mix.micTotalSamples = f.pending.windowStart + f.pending.windowSamples;
    if (change === 'inactive') f.mix.active = false;
    if (change === 'session') f.mix.generation += 1;
    if (change === 'capture') f.mix.micGeneration = 9;
    f.workflow.stepAnalysis(f.pending.deadlineMs + 1);
    assert.deepEqual(f.events, ['timing-payload', 'publish-timing']);
    assert.equal(f.probe.pendingAnalysis, null);
    assert.equal(f.probe.status(20_000).phase, 'idle');
    assert.equal(f.calibration.confirmedRevision, 0);
    assert.equal(f.mix.alignment.calibratedMicLagMs, null);
  });
}

test('old analysis waits at deadline equality and times out even if PCM arrives a millisecond later', () => {
  const f = pendingMicAnalysis();
  const needed = f.pending.windowStart + f.pending.windowSamples;
  f.mix.micTotalSamples = needed - 1;
  f.workflow.stepAnalysis(f.pending.deadlineMs);
  assert.deepEqual(f.events, []);
  assert.equal(f.probe.pendingAnalysis, f.pending);
  f.mix.micTotalSamples = needed;
  f.workflow.stepAnalysis(f.pending.deadlineMs + 1);
  assert.deepEqual(f.events, ['timing-payload', 'publish-timing']);
  assert.equal(f.probe.pendingAnalysis, null);
  assert.equal(f.probe.status(f.pending.deadlineMs + 1).phase, 'mic-retry-wait');
  assert.equal(f.calibration.confirmedRevision, 0);
  assert.equal(f.mix.alignment.calibratedMicLagMs, null);
});

for (const evidence of [
  { gapSamples: 14_401, frontierMissingSamples: 0 },
  { gapSamples: 0, frontierMissingSamples: 1 },
]) {
  test(`old analysis rejects unusable evidence before reading PCM: ${JSON.stringify(evidence)}`, () => {
    const f = pendingMicAnalysis();
    f.mix.micTotalSamples = f.pending.windowStart + f.pending.windowSamples;
    f.mix.readMicEvidence = () => { f.events.push('mic-evidence'); return evidence; };
    f.workflow.stepAnalysis(1_100);
    assert.deepEqual(f.events, ['mic-evidence', 'timing-payload', 'publish-timing']);
    assert.equal(f.probe.pendingAnalysis, null);
    assert.equal(f.probe.hasMicLeg, false);
    assert.equal(f.probe.correlations.mic, null);
    assert.equal(f.calibration.confirmedRevision, 0);
    assert.equal(f.mix.alignment.calibratedMicLagMs, null);
  });
}

test('old analysis consumes a complete silent window but spends a bounded correlation failure', () => {
  const f = pendingMicAnalysis();
  f.mix.micTotalSamples = f.pending.windowStart + f.pending.windowSamples;
  f.workflow.stepAnalysis(1_100);
  assert.deepEqual(f.events, ['mic-evidence', 'mic-pcm', 'timing-payload', 'publish-timing']);
  assert.equal(f.probe.pendingAnalysis, null);
  assert.equal(f.probe.hasMicLeg, false);
  assert.equal(f.probe.correlations.mic, -1);
  assert.equal(f.probe.status(1_100).phase, 'mic-retry-wait');
  assert.equal(f.calibration.confirmedRevision, 0);
  assert.equal(f.mix.alignment.calibratedMicLagMs, null);
});

test('old two-leg analysis uses the real chime/DSP and preserves rate conversion and Source send reads', () => {
  const f = pendingMicAnalysis();
  const reference = generateProbeReference(48_000);
  f.mix.readMic = (_start, count) => {
    f.events.push('mic-pcm');
    const pcm = new Int16Array(count);
    pcm.set(reference, 15_600); // margin/8 + 200ms latency, both exact 5ms bins
    return pcm;
  };
  f.mix.micTotalSamples = f.pending.windowStart + f.pending.windowSamples;
  f.workflow.stepAnalysis(1_100);
  assert.deepEqual(f.events, ['mic-evidence', 'mic-pcm', 'timing-payload', 'publish-timing']);
  assert.equal(f.probe.status(1_100).phase, 'backing-waiting');
  assert.equal(f.probe.micLeg?.actualSample, 70_080);
  assert.equal(f.probe.micLeg?.targetSample, 60_480);
  assert.equal(f.probe.micLeg?.correlation, 1);
  assert.equal(f.calibration.confirmedRevision, 0, 'one leg cannot promote calibration');
  f.events.length = 0;
  f.workflow.stepAdmission(1_200);
  assert.equal(f.messages[1].target, f.sourceSocket);
  assert.deepEqual(f.messages[1].payload, {
    type: 'play-calibration-probe', target: 'backing', requestId: 2, leadMs: 250,
  });
  const send = f.events.indexOf('send:backing');
  assert.deepEqual(f.events.slice(send - 2), [
    'source-socket', 'source-socket', 'send:backing', 'timing-payload', 'publish-timing',
  ]);
  f.workflow.handleReply({ requestId: 2, generation: 'not-a-capture-echo' }, 1_220);
  const backingAnalysis = f.probe.pendingAnalysis;
  assert.ok(backingAnalysis);
  assert.equal(backingAnalysis.targetSample, 70_080);
  f.mix.readBacking = (_start, count) => {
    f.events.push('backing-pcm');
    const pcm = new Int16Array(count);
    pcm.set(reference, 8_400); // margin/8 + 50ms latency
    return pcm;
  };
  f.mix.backingTotalSamples = backingAnalysis.windowStart + backingAnalysis.windowSamples;
  f.events.length = 0;
  f.workflow.stepAnalysis(1_300);
  assert.deepEqual(f.events, ['backing-evidence', 'backing-pcm', 'delta', 'rate', 'apply']);
  assert.deepEqual(f.probe.calibrationResult, {
    advanceMs: 200, micLatencyMs: 200, backingLatencyMs: 50, deltaMs: 100, confidence: 1,
  });
  assert.deepEqual(f.calibration.result, { micLagMs: 200, confidence: 1 });
  assert.equal(f.calibration.confirmedRevision, 1);
  assert.equal(f.mix.alignment.calibratedMicLagMs, 200);
  assert.equal(f.probe.completedContextMatches(f.workflow.context()), true);
  assert.equal(f.probe.hasMicLeg, false);
  f.workflow.stepAdmission(2_000);
  assert.equal(f.messages.length, 2, 'a successful current-context baseline does not restart');
  // Calibration here is a sink fixture, not proof of async-worker fencing.
  // That required C0 proof must separately compose the real CalibrationSession.
});

function reapplyFixture() {
  const f = fixture();
  f.probe.recordCalibration(f.workflow.context(), {
    advanceMs: 150, micLatencyMs: 200, backingLatencyMs: 100, deltaMs: 100, confidence: 0.82,
  });
  f.control.appliedKind = 'boot-probe';
  f.control.advance = 200;
  f.mix.alignment.calibratedMicLagMs = 150;
  const reapply = f.probe.reapplyCalibration.bind(f.probe);
  f.probe.reapplyCalibration = (advance, delta) => {
    f.events.push(`reapply:${advance}:${delta}`);
    return reapply(advance, delta);
  };
  const mark = f.timing.markBootProbeAuthority.bind(f.timing);
  f.timing.markBootProbeAuthority = () => { f.events.push('mark-boot'); mark(); };
  Object.defineProperty(f.probe, 'confidence', {
    get() {
      f.events.push('confidence');
      return Reflect.get(BootProbeRuntime.prototype, 'confidence', f.probe) as number | null;
    },
  });
  f.events.length = 0;
  return f;
}

for (const appliedKind of ['boot-probe', 'content', 'none'] as const) {
  test(`old reapply ${appliedKind} preserves sampling, owner mutation and lazy confidence`, () => {
    const f = reapplyFixture();
    f.control.appliedKind = appliedKind;
    f.workflow.stepReapply(1_000);
    assert.deepEqual(f.events, ['take', 'route', 'backing-robot', 'applied-kind',
      ...(appliedKind === 'boot-probe' ? [] : ['applicability']),
      'song', 'delta-fresh', 'advance', 'delta', 'reapply:200:100', 'mark-boot', 'confidence', 'apply']);
    assert.equal(f.probe.calibrationResult?.advanceMs, 200);
    assert.equal(f.mix.alignment.calibratedMicLagMs, 200);
    assert.equal(f.calibration.confirmedRevision, 1);
  });
}

for (const guard of ['take', 'legacy', 'applicable-content', 'hold-content', 'no-song',
  'no-path', 'collecting', 'transaction', 'no-delta', 'different-context', 'no-advance', 'below-threshold'] as const) {
  test(`old reapply stays inert for ${guard} without settling domain authority`, () => {
    const f = reapplyFixture();
    if (guard === 'take') f.facts.take = 'recording';
    if (guard === 'legacy') { f.facts.robot = false; f.facts.backing = false; }
    if (guard === 'applicable-content' || guard === 'hold-content') {
      f.control.appliedKind = 'content';
      f.control.applicability = guard === 'applicable-content' ? 'apply' : 'hold';
    }
    if (guard === 'no-song') f.control.song = false;
    if (guard === 'no-path') f.probe.clear();
    if (guard === 'collecting') f.calibration.collecting = true;
    if (guard === 'transaction') f.calibration.transactionActive = true;
    if (guard === 'no-delta') f.control.deltaFresh = false;
    if (guard === 'different-context') f.mix.backingGeneration = 9;
    if (guard === 'no-advance') f.control.advance = null;
    if (guard === 'below-threshold') f.control.advance = 199.999;
    f.workflow.stepReapply(1_000);
    assert.equal(f.events.includes('apply'), false);
    assert.equal(f.events.includes('mark-boot'), false);
    assert.equal(f.events.includes('confidence'), false);
    assert.equal(f.events.includes('delta'), false, 'promotion delta remains lazy even after other facts are sampled');
    assert.equal(f.calibration.confirmedRevision, 0);
    assert.equal(f.mix.alignment.calibratedMicLagMs, 150);
    if (guard === 'take') assert.deepEqual(f.events, ['take']);
    else if (guard === 'legacy') assert.deepEqual(f.events, ['take', 'route', 'backing-robot', 'source-connected']);
    else assert.deepEqual(f.events, ['take', 'route', 'backing-robot', 'applied-kind',
      ...(guard === 'applicable-content' || guard === 'hold-content' ? ['applicability'] : []),
      'song', 'delta-fresh', 'advance'], 'policy fields preserve eager object-literal query order');
  });
}

test('old admission reconciles a stale Mic leg before choosing the next request', () => {
  const f = fixture();
  f.probe.setMicLeg({ targetSample: 1, actualSample: 2, correlation: 0.9,
    sessionGeneration: 1, micGeneration: 999, micSourceRate: 48_000 });
  f.workflow.stepAdmission(1_000);
  assert.equal(f.probe.hasMicLeg, false);
  assert.equal(f.messages[0].payload.target, 'mic');
  assert.equal(f.messages[0].payload.requestId, 1);
  assert.equal(f.probe.status(1_000).attempts.mic, 1);
  assert.equal(f.probe.status(1_000).attempts.backing, 0);
});

test('old Backing failure retries without discarding its Mic leg then terminates at the bound', () => {
  const f = fixture();
  f.probe.setMicLeg({ targetSample: 1, actualSample: 2, correlation: 0.9,
    sessionGeneration: 1, micGeneration: 2, micSourceRate: 48_000 });
  f.workflow.stepAdmission(1_000);
  assert.equal(f.messages[0].payload.target, 'backing');
  f.workflow.handleFailure({ requestId: 1, generation: null, reason: 'one' }, 1_010);
  assert.equal(f.probe.hasMicLeg, true);
  f.workflow.stepAdmission(1_110);
  f.workflow.handleFailure({ requestId: 2, generation: null, reason: 'two' }, 1_120);
  assert.equal(f.probe.status(1_120).phase, 'failed');
  assert.equal(f.probe.status(1_120).active, false);
  assert.deepEqual(f.probe.status(1_120).attempts, { mic: 0, backing: 2 });
  assert.equal(f.events.at(-1), 'fail:Song source timing probe failed after 2 attempts: two');
  f.workflow.stepAdmission(2_000);
  assert.equal(f.messages.length, 2);
});

test('old debug analysis performs its extra 20-second PCM read before reporting failure', () => {
  const f = fixture({}, true);
  f.workflow.stepAdmission(1_000);
  f.workflow.handleReply({ requestId: 1, generation: 2 }, 1_020);
  const pending = f.probe.pendingAnalysis;
  assert.ok(pending);
  const reached = pending.windowStart + pending.windowSamples;
  f.mix.micTotalSamples = reached;
  f.mix.readMic = (start, count) => {
    f.events.push(`pcm:${start}:${count}`);
    return new Int16Array(count);
  };
  f.events.length = 0;
  f.workflow.stepAnalysis(1_100);
  assert.deepEqual(f.events, ['mic-evidence', 'pcm:54480:70560', `pcm:${reached - 960_000}:960000`,
    '[probe] mic correlation=-1.000 latencyMs=-125 windowPeak=0 recent20sPeak=0 windowStart=54480 needed=125040 reached=125040',
    'timing-payload', 'publish-timing'].map(event => event.startsWith('[probe]') ? `debug:${event}` : event));
  assert.equal(f.calibration.confirmedRevision, 0);
});

for (const throwAt of ['send:mic', 'timing-payload', 'publish-timing'] as const) {
  test(`old request effects propagate synchronous exceptions at ${throwAt}`, () => {
    const f = fixture();
    f.control.throwAt = throwAt;
    assert.throws(() => f.workflow.stepAdmission(1_000), { message: throwAt });
    assert.equal(f.events.at(-1), throwAt);
    assert.equal(f.probe.status(1_000).phase, 'mic-requested', 'the request was admitted before transport effects');
    assert.equal(f.probe.status(1_000).attempts.mic, 1);
    assert.equal(f.calibration.confirmedRevision, 0);
  });
}

function contentAnswer(lag: number): TimingCalibrationAnalysis {
  return { micLagMs: lag, confidence: 0.8, segmentLagsMs: [lag, lag, lag],
    segmentCorrelations: [0.9, 0.9, 0.9], micLevelDbfs: -20, backingLevelDbfs: -12 };
}
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));

// Reuse the actual calibration owner's applicability and mixer application,
// not a new approximation of how boot/content authority ought to be applied.
function canonicalApplication(dependencies: Record<string, unknown>) {
  const applicability = functionCode(applicationOwner, 'calibrationApplicability')
    .replace(/^function calibrationApplicability\([\s\S]*?\{/, 'function calibrationApplicability(kind = appliedCalibrationKind()) {');
  const sync = functionCode(applicationOwner, 'syncAppliedCalibration')
    .replace('calibration.result!.micLagMs', 'calibration.result.micLagMs');
  const bindings: Record<string, unknown> = { ...dependencies, queries: dependencies };
  const names = Object.keys(bindings);
  return new Function(...names, `${applicability}\n${sync}\nreturn {
    calibrationApplicability, syncAppliedCalibration,
  };`)(...names.map(name => bindings[name])) as {
    calibrationApplicability(kind?: TimingCalibrationKind): 'apply' | 'hold' | 'revoke';
    syncAppliedCalibration(): boolean;
  };
}

function measuredBootFixture(previousContent: boolean) {
  const f = fixture();
  const mix = new AudioSession({ sampleRate: 48_000, frameMs: 20,
    prebufferMs: 0, backingGain: 1, retentionMs: 10_000 });
  mix.start(0);
  const reference = generateProbeReference(48_000);
  const micPCM = new Int16Array(200_000);
  const backingPCM = new Int16Array(200_000);
  micPCM.set(reference, 70_080);
  backingPCM.set(reference, 72_480);
  assert.equal(mix.ingestMic({ generation: 2, firstSampleIndex: 0,
    pcm: Buffer.from(micPCM.buffer) }, 48_000, 0).start, 0);
  assert.equal(mix.ingestBacking({ generation: 3, firstSampleIndex: 0,
    pcm: Buffer.from(backingPCM.buffer) }, 48_000, 0).start, 0);
  const context = (): CalibrationContext => ({ sessionGeneration: mix.generation,
    micGeneration: mix.micGeneration, backingGeneration: mix.backingGeneration,
    micSourceRate: 48_000, backingSourceRate: 48_000, sourceGeneration: 4 });
  const bootContext = (): BootProbeContext => ({ sessionGeneration: mix.generation,
    micGeneration: mix.micGeneration, backingGeneration: mix.backingGeneration,
    micSourceRate: 48_000, backingSourceRate: 48_000 });
  const mapper = new RobotContentTimelineMapper({ sampleRate: 48_000, freshForMs: 20_000 });
  mapper.notePlayerOffset(100, context(), 0, 2);
  const control = { deferred: true, lag: 300, settled: 0 };
  const pending: Array<{ signal: AbortSignal | undefined;
    resolve(value: TimingCalibrationAnalysis): void; reject(error: unknown): void }> = [];
  const calibration = new CalibrationSession({ sampleRate: 48_000,
    durationMs: 6_000, timeoutMs: 20_000, agreementWindows: 1, now: () => 0, context,
    analyze: (_mic, _backing, _rate, _maxLag, signal) => {
      if (!control.deferred) return contentAnswer(control.lag);
      return new Promise<TimingCalibrationAnalysis>((resolve, reject) => {
        pending.push({ resolve, reject, signal });
      });
    },
    onSettled: () => {
      control.settled += 1;
      f.timing.syncConfirmedAuthority({ confirmedRevision: calibration.confirmedRevision,
        hasConfirmedResult: calibration.confirmedResult !== null });
      application.syncAppliedCalibration();
      f.events.push('settled-timing', 'settled-source');
    },
  });
  const appliedKind = () => f.timing.appliedCalibrationKind({
    hasConfirmedResult: calibration.confirmedResult !== null,
    provisional: calibration.status().provisional,
  });
  const bootSettled = () => f.probe.status(0).error !== null
    || (f.probe.pathDifferenceMs !== null && f.probe.completedContextMatches(bootContext()));
  const dependencies = { ...f.dependencies, session: mix, calibration,
    appliedCalibrationKind: appliedKind,
    calibrationIsStale: () => calibration.isStaleFor(context()),
    bootProbeContext: bootContext,
    bootProbeSettled: bootSettled,
    robotDeltaEverEstablished: () => true,
    robotContentMappingReady: () => mapper.isReady(context(), 0),
    contentLiveLagMs: (lag: number) => mapper.liveLagMs(lag, context(), 0),
    performance: { now: () => 0 },
    decideCalibrationApplicability, decideCalibrationMixerApplication, decideBootProbeMixerApplication,
  };
  const application = canonicalApplication(dependencies);
  const workflow = workflowFromPorts({ ...dependencies,
    calibrationApplicability: application.calibrationApplicability });
  const manual = createRelayManualBootRecalibrationCoordinator({
    clearContentValidation() { f.events.push('clear-validation'); f.timing.clearContentValidationBaseline(); },
    beginExternalRecalibration() { f.events.push('begin-external'); calibration.beginExternalRecalibration(); },
    syncAppliedCalibration() { f.events.push('sync-old-authority'); application.syncAppliedCalibration(); },
    beginManualBootProbe() { f.events.push('begin-manual-boot'); f.timing.beginBootProbe(false); },
    abandonProbeRun() { f.events.push('abandon'); workflow.abandon(); },
    resetProbeCorrelations() { f.events.push('reset-correlations'); f.probe.resetCorrelations(); },
    maybeStartProbeCalibration(now) { f.events.push(`admit:${now}`); workflow.stepAdmission(now); },
    reportTimingStatus() { f.events.push('manual-timing'); },
    reportSourceStatus() { f.events.push('manual-source'); },
  });
  if (previousContent) {
    f.probe.recordCalibration(bootContext(), { advanceMs: 150, micLatencyMs: 200,
      backingLatencyMs: 100, deltaMs: 100, confidence: 0.8 });
    f.timing.markContentAuthority();
    calibration.applyValidatedResult(contentAnswer(240));
    assert.equal(mix.alignment.calibratedMicLagMs, 240);
    assert.equal(appliedKind(), 'content');
  }
  function collectContent() {
    f.timing.beginContentCalibration(0, false);
    calibration.start(0);
    const pcm = new Int16Array(288_000);
    calibration.observeMic(pcm, 0);
    calibration.observeBacking(pcm, 0);
  }
  function promoteBoot() {
    workflow.handleReply({ requestId: 1, generation: 2 }, 1_020);
    workflow.stepAnalysis(1_100);
    assert.equal(f.probe.hasMicLeg, true);
    workflow.stepAdmission(1_200);
    assert.equal(f.messages.at(-1)?.payload.target, 'backing');
    workflow.handleReply({ requestId: 2, generation: null }, 1_220);
    workflow.stepAnalysis(1_300);
  }
  return { f, mix, calibration, control, pending, workflow, manual, application,
    appliedKind, bootSettled, collectContent, promoteBoot };
}

for (const previousContent of [false, true]) {
  for (const answer of ['resolve', 'reject'] as const) for (const when of ['before', 'after'] as const) {
    test(`old real worker ${answer} ${when} new boot promotion cannot overwrite authority: retained=${previousContent}`, async () => {
      const h = measuredBootFixture(previousContent);
      h.collectContent();
      assert.equal(h.pending.length, 1);
      assert.equal(h.pending[0].signal?.aborted, false);
      const oldRevision = previousContent ? 1 : 0;
      h.f.events.length = 0;
      h.manual.restart(1_000);
      assert.equal(h.pending[0].signal?.aborted, true);
      assert.equal(h.calibration.confirmedRevision, oldRevision);
      assert.equal(h.mix.alignment.calibratedMicLagMs, previousContent ? 240 : null);
      assert.equal(h.calibration.transactionActive, true);
      assert.equal(h.f.timing.calibrationKind, 'boot-probe');
      assert.equal(h.appliedKind(), previousContent ? 'content' : 'none');
      assert.deepEqual(h.f.events.slice(0, 7), ['clear-validation', 'begin-external',
        'sync-old-authority', 'take', 'route', 'backing-robot', 'strategy']);
      assert.deepEqual(h.f.events.filter(event => ['begin-manual-boot', 'abandon', 'reset-correlations',
        'admit:1000', 'manual-timing', 'manual-source'].includes(event)),
      ['begin-manual-boot', 'abandon', 'reset-correlations', 'admit:1000', 'manual-timing', 'manual-source']);
      if (when === 'after') h.promoteBoot();
      const expectedRevision = oldRevision + (when === 'after' ? 1 : 0);
      const expectedLag = when === 'after' ? 200 : previousContent ? 240 : null;
      const settled = h.control.settled;
      const events = [...h.f.events];
      if (answer === 'resolve') h.pending[0].resolve(contentAnswer(999));
      else h.pending[0].reject(new Error('retired worker failure'));
      await nextTurn();
      assert.equal(h.calibration.confirmedRevision, expectedRevision);
      assert.equal(h.mix.alignment.calibratedMicLagMs, expectedLag);
      assert.equal(h.control.settled, settled);
      assert.deepEqual(h.f.events, events, 'retired worker cannot settle/publish or change alignment');
      assert.equal(h.calibration.status().error, null);
      if (when === 'before') h.promoteBoot();
      assert.equal(h.calibration.confirmedRevision, oldRevision + 1);
      assert.equal(h.calibration.confirmedResult?.micLagMs, 200);
      assert.equal(h.mix.alignment.calibratedMicLagMs, 200);
      assert.equal(h.appliedKind(), 'boot-probe');
      assert.equal(h.bootSettled(), true);
      assert.equal(autoContentCalibrationPrerequisitesReady({ bootProbeSettled: h.bootSettled(),
        robotRouteActive: true, robotEvidenceMappingReady: true, sessionActive: h.mix.active,
        calibrationCollecting: h.calibration.collecting }), true);
      assert.equal(autoContentCalibrationAuthorityAllowsStart({ freshConfirmedResult: true,
        robotRouteActive: true, appliedKind: h.appliedKind() }), true);
      h.control.deferred = false;
      h.collectContent();
      assert.equal(h.calibration.confirmedRevision, oldRevision + 2, 'new content successor can actually confirm');
      assert.equal(h.calibration.confirmedResult?.micLagMs, 300);
      assert.equal(h.mix.alignment.calibratedMicLagMs, 300);
      assert.equal(h.appliedKind(), 'content');
    });
  }
}

for (const answer of ['resolve', 'reject'] as const) {
  test(`old exhausted boot permits a real content successor and ignores its retired worker ${answer}`, async () => {
    const h = measuredBootFixture(false);
    h.collectContent();
    h.manual.restart(1_000);
    h.workflow.handleFailure({ requestId: 1, generation: 2, reason: 'first' }, 1_010);
    h.workflow.stepAdmission(1_110);
    h.workflow.handleFailure({ requestId: 2, generation: 2, reason: 'second' }, 1_120);
    assert.equal(h.f.probe.status(1_120).phase, 'failed');
    assert.equal(h.calibration.transactionActive, false);
    assert.equal(h.calibration.confirmedRevision, 0);
    assert.equal(h.mix.alignment.calibratedMicLagMs, null);
    assert.equal(h.bootSettled(), true);
    assert.equal(autoContentCalibrationPrerequisitesReady({ bootProbeSettled: h.bootSettled(),
      robotRouteActive: true, robotEvidenceMappingReady: true, sessionActive: h.mix.active,
      calibrationCollecting: h.calibration.collecting }), true);
    assert.equal(autoContentCalibrationAuthorityAllowsStart({ freshConfirmedResult: false,
      robotRouteActive: true, appliedKind: null }), true);
    h.control.deferred = false;
    h.collectContent();
    const settled = h.control.settled;
    const events = [...h.f.events];
    if (answer === 'resolve') h.pending[0].resolve(contentAnswer(999));
    else h.pending[0].reject(new Error('retired failure after exhausted boot'));
    await nextTurn();
    assert.equal(h.calibration.status().state, 'complete');
    assert.equal(h.calibration.status().error, null);
    assert.equal(h.calibration.confirmedRevision, 1);
    assert.equal(h.mix.alignment.calibratedMicLagMs, 300);
    assert.equal(h.appliedKind(), 'content');
    assert.equal(h.control.settled, settled);
    assert.deepEqual(h.f.events, events);
  });

  test(`old external boot promotion itself aborts a subsequently pending content worker ${answer}`, async () => {
    const h = measuredBootFixture(true);
    h.manual.restart(1_000);
    h.workflow.handleReply({ requestId: 1, generation: 2 }, 1_020);
    h.workflow.stepAnalysis(1_100);
    h.workflow.stepAdmission(1_200);
    h.collectContent();
    assert.equal(h.pending.length, 1);
    assert.equal(h.pending[0].signal?.aborted, false);
    h.workflow.handleReply({ requestId: 2, generation: null }, 1_220);
    h.workflow.stepAnalysis(1_300);
    assert.equal(h.pending[0].signal?.aborted, true, 'applyExternalResult independently fences the pending analysis');
    assert.equal(h.calibration.confirmedRevision, 2);
    assert.equal(h.mix.alignment.calibratedMicLagMs, 200);
    assert.equal(h.appliedKind(), 'boot-probe');
    const settled = h.control.settled;
    const events = [...h.f.events];
    if (answer === 'resolve') h.pending[0].resolve(contentAnswer(999));
    else h.pending[0].reject(new Error('retired failure after boot promotion'));
    await nextTurn();
    assert.equal(h.calibration.confirmedRevision, 2);
    assert.equal(h.mix.alignment.calibratedMicLagMs, 200);
    assert.equal(h.calibration.status().error, null);
    assert.equal(h.control.settled, settled);
    assert.deepEqual(h.f.events, events);
  });
}
