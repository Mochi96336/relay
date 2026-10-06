import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { AudioSession } from '../src/audio-session.js';
import { buildReadiness } from '../src/readiness.js';
import { projectRemoteStatus, type RemoteStatusFacts } from '../src/relay-status-projection.js';
import { createRelayStatusFacts as createCollector } from '../src/relay-status-facts.js';
import { TakeSession } from '../src/take-session.js';
import { functionCode, parseTypeScriptSource, variableInitializerCode } from './support/source-contract.js';

function opaque<T>(label: string) {
  return { label } as unknown as T;
}

function fixture() {
  const calls: string[] = [];
  function tracked<T extends object>(name: string, target: T): T {
    const proxy = new Proxy(target, {
      get(owner, key, receiver) {
        const value = Reflect.get(owner, key, receiver);
        if (typeof key !== 'string') return value;
        if (typeof value !== 'function') {
          calls.push(`${name}.${key}`);
          return value;
        }
        return function (this: unknown, ...args: unknown[]) {
          assert.equal(this, proxy, `${name}.${key} must retain its owner receiver`);
          calls.push(`${name}.${key}(${args.join(',')})`);
          return Reflect.apply(value, owner, args);
        };
      },
    });
    return proxy;
  }
  const readiness = buildReadiness({
    routeMode: 'idle', backingConnected: false, backingStreaming: false,
    backingSampleRate: null, backingIsRobot: false, micConnected: true,
    micStreaming: true, robotSourceConnected: false, sessionActive: true,
    timelineConnected: false, timelineState: null, playerOffsetMs: null,
    playerOffsetFresh: false, calibrationState: 'idle', calibrationValid: false,
    calibrationStale: false, calibrationKind: 'none', probeCorrelation: { mic: null, backing: null },
    bootCalibration: null,
  });
  const health: RemoteStatusFacts['mix']['health'] = {
    micStarvedFrames: 4, backingStarvedFrames: 0, micHeadroomMs: 180,
    backingHeadroomMs: 400, micGapMs: 30, backingGapMs: 0,
    backingClockCorrectionSamples: 0, clippedSamples: 0, limitedSamples: 96,
    micPeakDbfs: -9, micRmsDbfs: -24, unheadered: false,
  };
  const micFacts: RemoteStatusFacts['mic'] = {
    mediaPath: 'webtransport', frameAgeMs: 8, sampleRate: 48_000,
    captureAndSender: opaque('capture'), receiverTransport: opaque('receiver'),
    receiverRetransmit: opaque('retransmit'), audibility: opaque('audibility'),
    level: opaque('level'), micGainDb: -3, concealedSamples: 7_200,
    clockDrift: null, clockTrimPpm: 12, anchorExcessMs: 4,
    frontierCorrectionMs: 1_250.6, timelineFolds: 2,
    lastTimelineFold: { shiftMs: 400, correctionBeforeMs: 1_650, captureLossMs: 420 },
    captureDelivery: { generation: 7, lossMs: 420, ratio: 0.97, windowMs: 30_000 },
  };
  const state = {
    lastFrameAt: 988.2,
    playerError: { videoId: 'blocked', code: 150 },
    snapshot: {
      serverIncarnation: 'fixture', revision: 3, micOwnerId: null,
      participants: [true, false, true].map((connected, index) => ({
        id: `participant-${index}`, nickname: `Singer ${index}`, connected,
        joinedAt: 0, lastSeenAt: 0, reconnectingUntil: null,
      })),
    },
    droppedFrames: 7,
  };
  const readers = {
    mixSampleRate: 48_000,
    mix: tracked('mix', {
      alignment: { calibratedMicLagMs: 210 }, health: () => health, active: true,
      micGainDb: -3, micConcealedSampleCount: 7_200, micClockTrimPpm: 12,
      micFrontierCorrectionMs: 1_250.6, micTimelineFoldCount: 2,
      lastMicTimelineFold: micFacts.lastTimelineFold,
      requestedMicAdvanceMs: 250, appliedMicAdvanceMs: 250,
    }),
    participants: tracked('participants', { snapshot: () => state.snapshot }),
    monitor: tracked('monitor', {
      recentDrops: (_now: number) => ({ frames: 2, listeners: 1, windowMs: 30_000 }),
      get droppedFrames() { return state.droppedFrames; },
    }),
    backing: tracked('backing', {
      get lastFrameAt() { return state.lastFrameAt; },
      armed: () => false, connected: () => false, sampleRate: null, isRobot: false,
    }),
    robot: tracked('robot', {
      get playerError() { return state.playerError; },
      routeActive: () => false, deltaFresh: (_now: number) => false,
      probeTimingActive: () => false, contentEvidenceReady: (_now: number) => false,
      offset: tracked('offset', { offsetMs: (_now: number) => null }),
    }),
    source: tracked('source', { connected: () => false }),
    song: {
      runtime: tracked('song', {
        statusPayload: (_now: number) => ({ connected: false }),
        roomStatusPayload: (_now: number) => ({ connected: false }),
      }),
      hasSong(now: number) { calls.push(`song.hasSong(${now})`); return false; },
    },
    take: { statusPayload: () => ({ ...new TakeSession().statusPayload(), history: [] }) },
    media: tracked('media', { backingPlayable: (_now: number) => false, micPlayable: (_now: number) => true }),
    timing: {
      calibration: tracked('calibration', { status: () => ({ state: 'idle' }) }),
      probe: tracked('probe', { correlations: { mic: null, backing: null }, calibrationResult: null }),
      applicability: () => { calls.push('timing.applicability()'); return 'revoke' as const; },
      isStale: () => { calls.push('timing.isStale()'); return false; },
      appliedKind: () => { calls.push('timing.appliedKind()'); return 'none' as const; },
      calibrationInProgress: (_now: number) => false,
      bootProbeInProgress: (_now: number) => false,
    },
    mic: {
      runtime: tracked('mic', {
        mediaPath: () => micFacts.mediaPath, frameAgeMs: (_now: number) => micFacts.frameAgeMs,
        sampleRate: micFacts.sampleRate,
        uplinkHealthPayload: (_now: number) => micFacts.captureAndSender,
        receiverStats: () => micFacts.receiverTransport,
        retransmitStats: () => micFacts.receiverRetransmit,
        connected: () => true, streaming: (_now: number) => true, flowObserved: () => true,
        startupTimedOut: (_now: number) => false, controlConnected: () => true,
        freshUplinkHealthPayload: (_now: number) => null,
      }),
      audibility: tracked('audibility', { status: () => micFacts.audibility, degraded: false }),
      level: tracked('level', { status: () => micFacts.level, warning: null }),
      drift: tracked('drift', {
        estimate: () => micFacts.clockDrift, anchorExcessMs: () => micFacts.anchorExcessMs,
      }),
      captureDelivery: tracked('captureDelivery', { status: () => micFacts.captureDelivery }),
    },
  };
  return { readers, calls, state, readiness, health, micFacts };
}

const trace = (now: number) => [
  'mix.alignment', 'participants.snapshot()', 'mix.health()',
  `monitor.recentDrops(${now})`,
  `song.statusPayload(${now})`, 'calibration.status()', 'robot.routeActive()',
  'backing.armed()', `song.hasSong(${now})`, 'backing.connected()',
  `media.backingPlayable(${now})`, 'backing.sampleRate', 'backing.isRobot',
  'mic.connected()', `media.micPlayable(${now})`, `mic.streaming(${now})`,
  'mic.flowObserved()', `mic.startupTimedOut(${now})`, 'source.connected()',
  'mix.active', 'robot.offset', `offset.offsetMs(${now})`, `robot.deltaFresh(${now})`,
  'timing.applicability()', 'timing.isStale()', 'timing.appliedKind()',
  'probe.correlations', 'probe.calibrationResult', 'backing.lastFrameAt',
  'robot.playerError', 'mix.active', 'monitor.droppedFrames', 'mic.mediaPath()',
  `mic.frameAgeMs(${now})`, 'mic.sampleRate', `mic.uplinkHealthPayload(${now})`,
  'mic.receiverStats()', 'mic.retransmitStats()', 'audibility.status()', 'level.status()',
  'mix.micGainDb', 'mix.micConcealedSampleCount', 'drift.estimate()',
  'mix.micClockTrimPpm', 'drift.anchorExcessMs()', 'mix.micFrontierCorrectionMs',
  'mix.micTimelineFoldCount', 'mix.lastMicTimelineFold', 'captureDelivery.status()',
];

test('remote preserves the complete getter order, counts, receiver and one explicit clock', () => {
  const f = fixture();
  const facts = createCollector(f.readers).remote(1_000.4);
  assert.deepEqual(f.calls, trace(1_000.4));
  assert.deepEqual(facts, {
    nowMs: 1_000.4, readiness: f.readiness, participants: { total: 3, connected: 2 },
    backingFrameAgeMs: 12, calibratedMicLagMs: 210,
    robotPlayerError: f.state.playerError, mixSampleRate: 48_000,
    mix: { active: true, health: f.health, monitorDroppedFrames: 7,
      monitorRecentDroppedFrames: 2, monitorRecentDroppingListeners: 1 },
    mic: f.micFacts,
  });
  assert.deepEqual(facts.readiness, f.readiness);
  assert.equal(facts.mix.health, f.health);
  assert.equal(facts.mic.captureAndSender, f.micFacts.captureAndSender);
});

test('constructing the collector does not read, prune or settle anything', () => {
  const f = fixture();
  createCollector(f.readers);
  assert.deepEqual(f.calls, []);
});

test('successive remote requests sample live participants, error and monitor housekeeping again', () => {
  const f = fixture();
  const collector = createCollector(f.readers);
  const first = collector.remote(1_000.4);
  f.state.snapshot = { ...f.state.snapshot, participants: [] };
  f.state.playerError = { videoId: 'next', code: 100 };
  f.state.droppedFrames = 9;
  f.readers.mix.micGainDb = 6;
  const second = collector.remote(2_000.4);
  assert.deepEqual(f.calls, [...trace(1_000.4), ...trace(2_000.4)]);
  assert.deepEqual(first.participants, { total: 3, connected: 2 });
  assert.deepEqual(second.participants, { total: 0, connected: 0 });
  assert.equal(first.robotPlayerError?.videoId, 'blocked');
  assert.equal(second.robotPlayerError?.videoId, 'next');
  assert.equal(second.mix.monitorDroppedFrames, 9);
  assert.equal(first.mic.micGainDb, -3);
  assert.equal(second.mic.micGainDb, 6);
  assert.notEqual(first.readiness, second.readiness);
  assert.equal(projectRemoteStatus(second).audio.micLevel.micGainDb, 6);
  assert.deepEqual(f.calls, [...trace(1_000.4), ...trace(2_000.4)]);
});

test('remote diagnostics read the actual AudioSession gain target anew after an accepted update', () => {
  const f = fixture();
  const session = new AudioSession({
    sampleRate: 48_000, frameMs: 20, prebufferMs: 400, backingGain: 0.65,
    retentionMs: 3_000, backingRetentionMs: 6_000,
  });
  const collector = createCollector({ ...f.readers, mix: session });
  session.setMicGainDb(12.5);
  const first = collector.remote(1_000);
  session.setMicGainDb(3.5);
  const second = collector.remote(2_000);
  assert.equal(first.mic.micGainDb, 12.5);
  assert.equal(second.mic.micGainDb, 3.5);
  assert.equal(projectRemoteStatus(first).audio.micLevel.micGainDb, 12.5);
  assert.equal(projectRemoteStatus(second).audio.micLevel.micGainDb, 3.5);
  assert.equal(session.micGainDb, 3.5);
});

test('existing remote projection consumes collected facts without additional owner reads', () => {
  const f = fixture();
  const facts = createCollector(f.readers).remote(1_000.4);
  const before = [...f.calls];
  const payload = projectRemoteStatus(facts);
  assert.deepEqual(f.calls, before);
  assert.equal(payload.uptimeMs, 1_000);
  assert.equal(payload.source.participants, 3);
  assert.equal(payload.audio.captureAndSender, f.micFacts.captureAndSender);
  assert.equal(payload.audio.timeline.micConcealedMs, 150);
});

for (const [at, expected] of [
  [NaN, null], [Infinity, null], [-Infinity, null],
  [988.2, 12], [1_002, -2], [1_000.5, -0], [999.5, 1], [0, 1_000],
] as const) {
  test(`backing frame age retains finite guard and Math.round for ${at}`, () => {
    const f = fixture();
    f.state.lastFrameAt = at;
    assert.equal(createCollector(f.readers).remote(1_000).backingFrameAgeMs, expected);
  });
}

test('production supplies live owners and a deferred Robot error query to the remote collector', () => {
  const url = new URL('../src/server.ts', import.meta.url);
  const source = parseTypeScriptSource(url, readFileSync(url, 'utf8'));
  const wiring = variableInitializerCode(source, 'relayStatusFacts');
  assert.match(wiring, /createRelayStatusFacts\(\{/);
  for (const [port, owner] of [
    ['mix', 'session'], ['participants', 'participants'], ['monitor', 'monitorTransport'],
    ['backing', 'backingRuntime'], ['runtime', 'micRuntime'],
    ['audibility', 'micAudibility'], ['level', 'micLevel'],
    ['drift', 'micClockDrift'], ['captureDelivery', 'micCaptureDelivery'],
  ]) {
    assert.match(wiring, new RegExp(port === owner ? `\\b${port},` : `\\b${port}: ${owner}\\b`));
  }
  assert.match(wiring, /mixSampleRate: MIX_SAMPLE_RATE/);
  assert.match(wiring, /get playerError\(\) \{ return robotPlayerError; \}/);
  assert.match(wiring, /source: sourceRuntime/);
  assert.match(wiring, /song: \{ runtime: youtubeTimeline, hasSong: roomHasSong \}/);
  assert.match(wiring, /applicability: calibrationApplicability/);
  for (const [port, owner] of [
    ['offset', 'robotPlayerOffset'], ['routeActive', 'robotRouteActive'],
    ['deltaFresh', 'robotDeltaIsFresh'], ['probeTimingActive', 'robotProbeTimingActive'],
    ['contentEvidenceReady', 'robotContentEvidenceMappingReady'], ['take', 'takeController'],
    ['probe', 'bootProbeRuntime'], ['isStale', 'calibrationIsStale'],
    ['appliedKind', 'appliedCalibrationKind'], ['calibrationInProgress', 'timingCalibrationInProgress'],
  ]) assert.match(wiring, new RegExp(`\\b${port}: ${owner}\\b`));
  assert.match(wiring, /media: \{ backingPlayable, micPlayable \}/);
  assert.match(wiring, /\bcalibration,/);
  assert.match(wiring, /\bbootProbeInProgress,/);
  assert.doesNotMatch(wiring, /readiness:.*readinessPayload/);
});

test('remote and observation wrappers keep their original non-atomic sampling sequence', () => {
  const url = new URL('../src/server.ts', import.meta.url);
  const source = parseTypeScriptSource(url, readFileSync(url, 'utf8'));
  assert.match(functionCode(source, 'remoteStatusPayload'),
    /projectRemoteStatus\(relayStatusFacts\.remote\(performance\.now\(\)\)\)/);
  assert.match(functionCode(source, 'readinessPayload'),
    /nowMs = performance\.now\(\)[\s\S]*relayStatusFacts\.readiness\(nowMs\)/);
  assert.match(functionCode(source, 'productStatusPayload'),
    /nowMs = performance\.now\(\)[\s\S]*projectProductStatus\(relayStatusFacts\.product\(nowMs\)\)/);
  const observation = functionCode(source, 'observationStatusV1Payload');
  assert.match(observation,
    /const remote = remoteStatusPayload\(\);[\s\S]*micLeaseHeld: participants\.snapshot\(\)\.micOwnerId !== null,[\s\S]*micSampleRate: micRuntime\.sampleRate/);
});
