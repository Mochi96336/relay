import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import type { CalibrationApplicability } from '../src/calibration-applicability.js';
import { buildReadiness } from '../src/readiness.js';
import { projectProductStatus, type ProductStatusFacts, type RemoteStatusFacts } from '../src/relay-status-projection.js';
import { createRelayStatusFacts as createCollector } from '../src/relay-status-facts.js';
import { TakeSession } from '../src/take-session.js';
import { functionCode, parseTypeScriptSource } from './support/source-contract.js';

const serverUrl = new URL('../src/server.ts', import.meta.url);
const server = parseTypeScriptSource(serverUrl, readFileSync(serverUrl, 'utf8'));

function fixture() {
  const calls: string[] = [];
  function tracked<T extends object>(name: string, target: T): T {
    const proxy = new Proxy(target, {
      get(owner, key, receiver) {
        const value = Reflect.get(owner, key, receiver);
        if (typeof key !== 'string') return value;
        if (typeof value !== 'function') { calls.push(`${name}.${key}`); return value; }
        return function (this: unknown, ...args: unknown[]) {
          assert.equal(this, proxy, `${name}.${key} must retain its query receiver`);
          calls.push(`${name}.${key}(${args.join(',')})`);
          return Reflect.apply(value, owner, args);
        };
      },
    });
    return proxy;
  }
  const state = {
    robotRoute: true, armed: true, hasSong: true,
    applicability: 'hold' as CalibrationApplicability,
    calibrationState: 'complete' as unknown,
    alignedLag: 210 as number | null,
    timeline: { connected: true, videoId: 'song', state: 1, ageMs: 12 } as {
      connected?: unknown; videoId?: unknown; state?: unknown; ageMs?: unknown;
    },
    room: { connected: true, videoId: 'song', state: 1, handoffState: 'idle' },
    controlConnected: true,
    micFlowObserved: true,
    micPlayable: true,
    micStartupDeadline: null as number | null,
    micOwnerId: 'p1' as string | null,
    nickname: 'Alice',
    warning: null as ProductStatusFacts['micLevelWarning'],
    degraded: false,
    playerError: null as ProductStatusFacts['robotPlayerError'],
  };
  const takeStatus = { ...new TakeSession().statusPayload(), history: [] };
  const correlation = { mic: 0.8, backing: 0.9 };
  const opaque = <T>(label: string) => ({ label }) as unknown as T;
  const readers = {
    mixSampleRate: 48_000,
    mix: tracked('mix', {
      get alignment() { return { calibratedMicLagMs: state.alignedLag }; },
      active: true, requestedMicAdvanceMs: 250, appliedMicAdvanceMs: 250,
      micFrontierCorrectionMs: 0,
      health: () => opaque<RemoteStatusFacts['mix']['health']>('health'),
      micGainDb: -3, micConcealedSampleCount: 0, micClockTrimPpm: 0,
      micTimelineFoldCount: 0, lastMicTimelineFold: null,
    }),
    participants: tracked('participants', { snapshot: () => ({
      serverIncarnation: 'fixture', revision: 1, micOwnerId: state.micOwnerId,
      participants: [{ id: 'p1', nickname: state.nickname, connected: true,
        joinedAt: 0, lastSeenAt: 0, reconnectingUntil: null }],
    }) }),
    backing: tracked('backing', {
      armed: () => state.armed, connected: () => true, sampleRate: 48_000, isRobot: true,
      lastFrameAt: 988.2,
    }),
    monitor: tracked('monitor', {
      recentDrops: (_now: number) => ({ frames: 0, listeners: 0, windowMs: 30_000 }),
      droppedFrames: 0,
    }),
    mic: {
      runtime: tracked('mic', {
        connected: () => true, streaming: (_now: number) => true,
        flowObserved: () => state.micFlowObserved,
        startupTimedOut: (now: number) => !state.micFlowObserved
          && state.micStartupDeadline !== null && now >= state.micStartupDeadline,
        controlConnected: () => state.controlConnected,
        freshUplinkHealthPayload: (_now: number) => null,
        mediaPath: () => 'webtransport' as const, frameAgeMs: (_now: number) => 8,
        sampleRate: 48_000, uplinkHealthPayload: (_now: number) => null,
        receiverStats: () => opaque<RemoteStatusFacts['mic']['receiverTransport']>('receiver'),
        retransmitStats: () => opaque<RemoteStatusFacts['mic']['receiverRetransmit']>('retransmit'),
      }),
      audibility: tracked('audibility', {
        get degraded() { return state.degraded; },
        status: () => opaque<RemoteStatusFacts['mic']['audibility']>('audibility'),
      }),
      level: tracked('level', {
        get warning() { return state.warning; },
        status: () => opaque<RemoteStatusFacts['mic']['level']>('level'),
      }),
      drift: tracked('drift', { estimate: () => null, anchorExcessMs: () => 0 }),
      captureDelivery: tracked('captureDelivery', {
        status: () => opaque<RemoteStatusFacts['mic']['captureDelivery']>('delivery'),
      }),
    },
    source: tracked('source', { connected: () => true }),
    song: {
      runtime: tracked('song', {
        statusPayload: (_now: number) => state.timeline,
        roomStatusPayload: (_now: number) => state.room,
      }),
      hasSong(now: number) { calls.push(`song.hasSong(${now})`); return state.hasSong; },
    },
    take: tracked('take', { statusPayload: () => takeStatus }),
    media: tracked('media', {
      backingPlayable: (_now: number) => true, micPlayable: (_now: number) => state.micPlayable,
    }),
    robot: tracked('robot', {
      get playerError() { return state.playerError; },
      routeActive: () => state.robotRoute, deltaFresh: (_now: number) => true,
      probeTimingActive: () => false, contentEvidenceReady: (_now: number) => true,
      offset: tracked('offset', { offsetMs: (_now: number) => 120 }),
    }),
    timing: tracked('timing', {
      calibration: tracked('calibration', { status: () => ({ state: state.calibrationState }) }),
      probe: tracked('probe', { correlations: correlation, calibrationResult: null }),
      applicability: () => state.applicability, isStale: () => false,
      appliedKind: () => 'content' as const,
      calibrationInProgress: (_now: number) => false,
      bootProbeInProgress: (_now: number) => false,
    }),
  };
  return { readers, calls, state, takeStatus, correlation };
}

// Group containers are wiring, not sampled domain facts.
function collector(f: ReturnType<typeof fixture>) {
  const result = createCollector(f.readers);
  f.calls.length = 0;
  return result;
}
function domainCalls(calls: string[]) {
  return calls.filter((call) => !['robot.offset', 'timing.calibration', 'timing.probe'].includes(call));
}

const readinessTrace = (now: number) => [
  `song.statusPayload(${now})`, 'calibration.status()', 'robot.routeActive()',
  'backing.connected()', `media.backingPlayable(${now})`, 'backing.sampleRate',
  'backing.isRobot', 'mic.connected()', `media.micPlayable(${now})`,
  `mic.streaming(${now})`, 'mic.flowObserved()', `mic.startupTimedOut(${now})`,
  'source.connected()', 'mix.active', `offset.offsetMs(${now})`,
  `robot.deltaFresh(${now})`, 'timing.applicability()', 'mix.alignment',
  'timing.isStale()', 'timing.appliedKind()', 'probe.correlations', 'probe.calibrationResult',
];
const productTrace = (now: number) => [
  ...readinessTrace(now), 'participants.snapshot()', `song.roomStatusPayload(${now})`,
  `song.statusPayload(${now})`, 'take.statusPayload()', 'mix.alignment',
  'calibration.status()', 'mic.controlConnected()', `mic.freshUplinkHealthPayload(${now})`,
  'audibility.degraded', 'level.warning', 'robot.playerError',
  `timing.calibrationInProgress(${now})`, 'timing.isStale()',
  'mix.requestedMicAdvanceMs', 'mix.appliedMicAdvanceMs', 'mix.micFrontierCorrectionMs',
  'robot.routeActive()', 'timing.appliedKind()', 'robot.probeTimingActive()',
  `timing.bootProbeInProgress(${now})`, `robot.contentEvidenceReady(${now})`, `robot.deltaFresh(${now})`,
];

test('constructing the readiness/product boundary does not sample owners or settle anything', () => {
  const f = fixture();
  createCollector(f.readers);
  assert.deepEqual(f.calls, []);
});

test('remote retains its prelude and the full nested readiness trace without collapsing queries', () => {
  const f = fixture();
  const facts = collector(f).remote(1_000.4);
  assert.deepEqual(domainCalls(f.calls), [
    'mix.alignment', 'participants.snapshot()', 'mix.health()', 'monitor.recentDrops(1000.4)',
    ...readinessTrace(1_000.4), 'backing.lastFrameAt', 'robot.playerError',
    'mix.active', 'monitor.droppedFrames', 'mic.mediaPath()', 'mic.frameAgeMs(1000.4)',
    'mic.sampleRate', 'mic.uplinkHealthPayload(1000.4)', 'mic.receiverStats()',
    'mic.retransmitStats()', 'audibility.status()', 'level.status()', 'mix.micGainDb',
    'mix.micConcealedSampleCount', 'drift.estimate()', 'mix.micClockTrimPpm',
    'drift.anchorExcessMs()', 'mix.micFrontierCorrectionMs', 'mix.micTimelineFoldCount',
    'mix.lastMicTimelineFold', 'captureDelivery.status()',
  ]);
  assert.equal(facts.calibratedMicLagMs, 210);
  assert.equal(facts.readiness.components.calibration.valid, true);
  assert.deepEqual(facts.participants, { total: 1, connected: 1 });
});

test('readiness preserves complete query order, counts, receivers and the explicit clock', () => {
  const f = fixture();
  const snapshot = collector(f).readiness(1_000.4);
  assert.deepEqual(domainCalls(f.calls), readinessTrace(1_000.4));
  assert.deepEqual(snapshot, buildReadiness({
    routeMode: 'robot', backingConnected: true, backingStreaming: true,
    backingSampleRate: 48_000, backingIsRobot: true, micConnected: true,
    micStreaming: true, micArriving: true, micFlowObserved: true, micStartupTimedOut: false,
    robotSourceConnected: true, sessionActive: true, timelineConnected: true,
    timelineState: 1, playerOffsetMs: 120, playerOffsetFresh: true,
    calibrationState: 'complete', calibrationValid: true, calibrationStale: false,
    calibrationKind: 'content', probeCorrelation: f.correlation, bootCalibration: null,
  }));
});

test('readiness samples the live Mic startup deadline with each request clock', () => {
  const f = fixture();
  Object.assign(f.state, { micFlowObserved: false, micPlayable: false, micStartupDeadline: 1_000 });
  const facts = collector(f);
  const before = facts.readiness(999);
  const expired = facts.readiness(1_000);
  assert.equal(before.components.mic.startupTimedOut, false);
  assert.equal(expired.components.mic.startupTimedOut, true);
  assert.equal(expired.components.mic.connected, true);
  assert.equal(expired.components.mic.flowObserved, false);
  assert.equal(expired.components.mic.streaming, false);
  f.state.micFlowObserved = true;
  f.state.micPlayable = true;
  const flowing = facts.readiness(1_001);
  assert.equal(flowing.components.mic.startupTimedOut, false);
  assert.equal(flowing.components.mic.flowObserved, true);
  assert.equal(flowing.components.mic.streaming, true);
  assert.equal(expired.components.mic.startupTimedOut, true, 'prior snapshot must remain unchanged');
  assert.deepEqual(domainCalls(f.calls), [
    ...readinessTrace(999), ...readinessTrace(1_000), ...readinessTrace(1_001),
  ]);
});

for (const [robot, armed, song, mode, queries] of [
  [true, true, true, 'robot', ['robot.routeActive()']],
  [false, true, true, 'legacy', ['robot.routeActive()', 'backing.armed()']],
  [false, false, true, 'song', ['robot.routeActive()', 'backing.armed()', 'song.hasSong(1000)']],
  [false, false, false, 'idle', ['robot.routeActive()', 'backing.armed()', 'song.hasSong(1000)']],
] as const) {
  test(`route ${mode} keeps the original predicate short circuit`, () => {
    const f = fixture();
    Object.assign(f.state, { robotRoute: robot, armed, hasSong: song });
    assert.equal(collector(f).readiness(1_000).components.route.mode, mode);
    assert.deepEqual(f.calls.filter((call) => /routeActive|armed|hasSong/.test(call)), queries);
  });
}

for (const [applicability, lag, valid, alignmentReads] of [
  ['revoke', 210, false, 0], ['hold', 210, true, 1],
  ['hold', null, false, 1], ['apply', 210, true, 1],
] as const) {
  test(`calibration ${applicability}/${lag} keeps validity and alignment short circuit`, () => {
    const f = fixture();
    f.state.applicability = applicability;
    f.state.alignedLag = lag;
    assert.equal(collector(f).readiness(1_000).components.calibration.valid, valid);
    assert.equal(f.calls.filter((call) => call === 'mix.alignment').length, alignmentReads);
    assert.equal(f.calls.filter((call) => call === 'timing.applicability()').length, 1);
  });
}

for (const [value, expected] of [
  [undefined, null], ['no-state', null], [Infinity, null], [null, 0], ['', 0], ['1', 1],
] as const) {
  test(`timeline state ${value} retains Number conversion and finite guard`, () => {
    const f = fixture();
    f.state.timeline.state = value;
    assert.equal(collector(f).readiness(1_000).components.player.state, expected);
  });
}

test('product still samples timeline, calibration and alignment again after readiness', () => {
  const f = fixture();
  const facts = collector(f).product(1_000.4);
  assert.deepEqual(domainCalls(f.calls), productTrace(1_000.4));
  assert.equal(facts.participantCount, 1);
  assert.equal(facts.micOwnerId, 'p1');
  assert.equal(facts.micOwnerNickname, 'Alice');
  assert.equal(facts.timelineAgeMs, 12);
  assert.equal(facts.takeStatus, f.takeStatus);
  assert.deepEqual(facts.timing, {
    calibratedMicLagMs: 210, calibrationState: 'complete', calibrationActive: false,
    calibrationStale: false, requestedMicAdvanceMs: 250, appliedMicAdvanceMs: 250,
    micFrontierCorrectionMs: 0, robotRouteActive: true, appliedCalibrationKind: 'content',
    robotProbeTimingActive: false, bootProbeActive: false,
    contentEvidenceReady: true, robotDeltaFresh: true,
  });
  const before = [...f.calls];
  const payload = projectProductStatus(facts);
  assert.deepEqual(f.calls, before);
  assert.equal(payload.room.mic.ownerNickname, 'Alice');
});

for (const owner of [null, 'missing', ''] as const) {
  test(`owner ${owner} preserves null nickname fallback`, () => {
    const f = fixture();
    f.state.micOwnerId = owner;
    const facts = collector(f).product(1_000);
    assert.equal(facts.micOwnerId, owner);
    assert.equal(facts.micOwnerNickname, null);
    assert.equal(facts.participantCount, 1);
  });
}

test('missing age remains NaN in facts; media connectivity is not control connectivity', () => {
  const f = fixture();
  f.state.timeline.ageMs = undefined;
  f.state.controlConnected = false;
  const facts = collector(f).product(1_000);
  assert.ok(Number.isNaN(facts.timelineAgeMs));
  assert.equal(facts.publisherControlConnected, false);
  assert.equal(facts.readiness.components.mic.connected, true);
});

test('product requests collect anew and preserve old samples instead of caching owners', () => {
  const f = fixture();
  const c = collector(f);
  const first = c.product(1_000);
  f.state.nickname = 'Bob';
  f.state.alignedLag = 280;
  f.state.calibrationState = undefined;
  const second = c.product(2_000);
  assert.deepEqual(domainCalls(f.calls), [...productTrace(1_000), ...productTrace(2_000)]);
  assert.equal(first.micOwnerNickname, 'Alice');
  assert.equal(second.micOwnerNickname, 'Bob');
  assert.equal(first.timing.calibratedMicLagMs, 210);
  assert.equal(second.timing.calibratedMicLagMs, 280);
  assert.equal(second.timing.calibrationState, 'idle');
});

test('production broadcast dedup samples every call but sends only changed projected content', () => {
  const f = fixture();
  const c = collector(f);
  const sent: unknown[] = [];
  const broadcast = new Function('productStatusPayload', 'broadcastJson', `
    let lastProductStatusJson = '';
    ${functionCode(server, 'broadcastProductStatus')}
    return broadcastProductStatus;
  `)((now: number) => projectProductStatus(c.product(now)), (payload: unknown) => sent.push(payload)) as (now: number) => boolean;
  assert.equal(broadcast(1_000), true);
  assert.equal(broadcast(2_000), false);
  f.state.warning = 'too-loud';
  assert.equal(broadcast(3_000), true);
  assert.equal(sent.length, 2);
  assert.equal(f.calls.filter((call) => call === 'participants.snapshot()').length, 3);
  const changed = sent[1] as ReturnType<typeof projectProductStatus>;
  assert.ok(changed.attention);
  assert.deepEqual(Object.keys(changed.attention).sort(), ['code', 'scope', 'severity']);
  assert.ok(!Object.hasOwn(changed, 'observedAtMs'));
});
