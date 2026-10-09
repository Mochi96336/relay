import assert from 'node:assert/strict';
import test from 'node:test';

import { buildReadiness, type ReadinessInput } from '../src/readiness.js';
import {
  projectObservationStatusV1,
  projectProductStatus,
  projectRemoteStatus,
  type ProductStatusFacts,
  type RemoteStatusFacts,
} from '../src/relay-status-projection.js';
import { deriveRemoteStatusHealth } from '../src/remote-status.js';

/** A Robot room playing a Song, with a live Mic and a boot-probe alignment. */
const ROBOT_ROOM: ReadinessInput = {
  routeMode: 'robot',
  backingConnected: true,
  backingStreaming: true,
  backingSampleRate: 48_000,
  backingIsRobot: true,
  micConnected: true,
  micStreaming: true,
  micArriving: true,
  micFlowObserved: true,
  robotSourceConnected: true,
  sessionActive: true,
  timelineConnected: true,
  timelineState: 1,
  playerOffsetMs: 120,
  playerOffsetFresh: true,
  calibrationState: 'complete',
  calibrationValid: true,
  calibrationStale: false,
  calibrationKind: 'boot-probe',
  probeCorrelation: { mic: 0.8, backing: 0.9 },
  bootCalibration: null,
};

/** Values the projection carries through untouched; identity proves it. */
function opaque<T>(label: string) {
  return { opaque: label } as unknown as T;
}

type MicFacts = RemoteStatusFacts['mic'];

function remoteFacts(overrides: Partial<RemoteStatusFacts> = {}): RemoteStatusFacts {
  return {
    nowMs: 90_000.4,
    readiness: buildReadiness(ROBOT_ROOM),
    participants: { total: 3, connected: 2 },
    backingFrameAgeMs: 12,
    calibratedMicLagMs: 210,
    robotPlayerError: null,
    mixSampleRate: 48_000,
    mix: {
      active: true,
      health: {
        micStarvedFrames: 4,
        backingStarvedFrames: 0,
        micHeadroomMs: 180,
        backingHeadroomMs: 400,
        micGapMs: 30,
        backingGapMs: 0,
        backingClockCorrectionSamples: 0,
        clippedSamples: 0,
        limitedSamples: 96,
        micPeakDbfs: -9,
        micRmsDbfs: -24,
        unheadered: false,
      },
      monitorDroppedFrames: 7,
      monitorRecentDroppedFrames: 2,
      monitorRecentDroppingListeners: 1,
    },
    mic: {
      mediaPath: 'webtransport',
      frameAgeMs: 8,
      sampleRate: 48_000,
      captureAndSender: opaque<MicFacts['captureAndSender']>('capture'),
      receiverTransport: opaque<MicFacts['receiverTransport']>('receiver'),
      receiverRetransmit: opaque<MicFacts['receiverRetransmit']>('retransmit'),
      audibility: opaque<MicFacts['audibility']>('audibility'),
      level: { warning: null, hotWindows: 0 } as unknown as MicFacts['level'],
      micGainDb: -3,
      concealedSamples: 7_200,
      clockDrift: null,
      clockTrimPpm: 12,
      anchorExcessMs: 4,
      frontierCorrectionMs: 1_250.6,
      timelineFolds: 2,
      lastTimelineFold: { shiftMs: 400, correctionBeforeMs: 1_650, captureLossMs: 420 },
      timelineUnfolds: 1,
      lastTimelineUnfold: { shiftMs: 300, correctionBeforeMs: 0, captureLossMs: 120 },
      captureDelivery: { generation: 7, lossMs: 420, ratio: 0.97, windowMs: 30_000 },
      uplinkBacklog: { generation: 7, backlogMs: 2_400, maxBacklogMs: 3_100 },
    },
    ...overrides,
  };
}

test('/statusz reads every readiness-owned fact from the one snapshot it is handed', () => {
  // A Mic whose PCM still arrives but is too far behind to be heard, on a
  // Robot route whose player delta went stale under a stale content alignment.
  const readiness = buildReadiness({
    ...ROBOT_ROOM,
    micStreaming: false,
    micArriving: true,
    playerOffsetFresh: false,
    calibrationKind: 'content',
    calibrationStale: true,
  });
  const status = projectRemoteStatus(remoteFacts({ readiness }));

  const health = deriveRemoteStatusHealth(readiness);
  assert.deepEqual(
    { ok: status.ok, state: status.state, faults: status.faults, warnings: status.warnings },
    health,
  );
  assert.equal(status.ok, false);
  assert.equal(status.source.backingConnected, true);
  assert.equal(status.source.backingStreaming, true);
  assert.equal(status.source.backingSampleRate, 48_000);
  assert.equal(status.source.backingIsRobot, true);
  assert.equal(status.source.micConnected, true);
  assert.equal(status.source.micStreaming, false);
  assert.equal(status.source.micArriving, true);
  assert.equal(status.robot.route, true);
  assert.equal(status.robot.sourceConnected, true);
  assert.equal(status.robot.deltaFresh, false);
  assert.equal(status.robot.calibrationKind, 'content');
  assert.equal(status.robot.calibrationStale, true);

  // The same sample with a healthy snapshot reports a healthy route: nothing
  // else in the facts can contradict the snapshot, because nothing else
  // carries these facts.
  const healthy = projectRemoteStatus(remoteFacts());
  assert.equal(healthy.ok, true);
  assert.equal(healthy.state, 'live');
  assert.equal(healthy.source.micStreaming, true);
  assert.equal(healthy.robot.deltaFresh, true);
  assert.equal(healthy.robot.calibrationKind, 'boot-probe');
});

test('/statusz reports the sampled mix and Mic timeline in its own units', () => {
  const facts = remoteFacts();
  const status = projectRemoteStatus(facts);

  assert.equal(status.uptimeMs, 90_000);
  assert.equal(status.source.backingFrameAgeMs, 12);
  assert.equal(status.source.micMediaPath, 'webtransport');
  assert.equal(status.source.micFrameAgeMs, 8);
  assert.equal(status.source.participants, 3);
  assert.equal(status.source.participantsConnected, 2);
  assert.equal(status.robot.timingMode, 'acoustic-calibration');
  assert.equal(status.robot.activeCalibratedMicLagMs, 210);
  assert.deepEqual(status.mix, {
    active: true,
    ...facts.mix.health,
    monitorDroppedFrames: 7,
    monitorRecentDroppedFrames: 2,
    monitorRecentDroppingListeners: 1,
  });

  assert.equal(status.audio.micMediaPath, 'webtransport');
  assert.equal(status.audio.micSampleRate, 48_000);
  assert.equal(status.audio.captureAndSender, facts.mic.captureAndSender);
  assert.equal(status.audio.receiverTransport, facts.mic.receiverTransport);
  assert.equal(status.audio.receiverRetransmit, facts.mic.receiverRetransmit);
  assert.equal(status.audio.micAudibility, facts.mic.audibility);
  assert.deepEqual(status.audio.micLevel, { warning: null, hotWindows: 0, micGainDb: -3 });
  assert.deepEqual(status.audio.timeline, {
    micGapMs: 30,
    micConcealedMs: 150,
    micClockDrift: null,
    micClockTrimPpm: 12,
    micAnchorExcessMs: 4,
    micHeadroomMs: 180,
    micStarvedFrames: 4,
    micFrontierCorrectionMs: 1_251,
    micTimelineFolds: 2,
    lastMicTimelineFold: { shiftMs: 400, correctionBeforeMs: 1_650, captureLossMs: 420 },
    micTimelineUnfolds: 1,
    lastMicTimelineUnfold: { shiftMs: 300, correctionBeforeMs: 0, captureLossMs: 120 },
  });
  assert.deepEqual(status.audio.micCaptureDelivery, facts.mic.captureDelivery);
  assert.deepEqual(status.audio.micUplinkBacklog, facts.mic.uplinkBacklog);

  const estimated = projectRemoteStatus(remoteFacts({ calibratedMicLagMs: null }));
  assert.equal(estimated.robot.timingMode, 'network-estimate');
  assert.equal(estimated.robot.activeCalibratedMicLagMs, null);
});

test('/statusz says whether the Robot player error means the video can never play', () => {
  assert.equal(projectRemoteStatus(remoteFacts()).robot.playerError, null);
  assert.deepEqual(
    projectRemoteStatus(remoteFacts({ robotPlayerError: { videoId: 'blocked', code: 150 } })).robot.playerError,
    { videoId: 'blocked', code: 150, unplayable: true },
  );
  // HTML5 player failure: worth a reload, not a different Song.
  assert.deepEqual(
    projectRemoteStatus(remoteFacts({ robotPlayerError: { videoId: 'glitch', code: 5 } })).robot.playerError,
    { videoId: 'glitch', code: 5, unplayable: false },
  );
});

test('the v1 observation contract is /statusz plus the Mic lease, with a closed calibration kind', () => {
  const remote = projectRemoteStatus(remoteFacts());
  const observation = projectObservationStatusV1(
    remote,
    { micLeaseHeld: true, micSampleRate: 44_100 },
    '2026-10-04T12:00:00.000Z',
  );

  assert.equal(observation.schema, 'relay.observation.v1');
  assert.equal(observation.generatedAt, '2026-10-04T12:00:00.000Z');
  assert.deepEqual(observation.workload, { id: 'relay', state: 'live', ok: true, uptimeMs: 90_000 });
  assert.deepEqual(observation.activity, {
    sessionActive: true,
    participants: { total: 3, connected: 2 },
    microphoneLease: { held: true, transportConnected: true },
  });
  assert.equal(observation.sources.microphone.sampleRate, 44_100);
  assert.deepEqual(observation.sources.robot, {
    routeActive: true,
    sourceConnected: true,
    playerDeltaFresh: true,
  });
  assert.equal(observation.mix, remote.mix);
  assert.deepEqual(observation.issues, { faults: [], warnings: [] });

  const kindFor = (calibrationKind: string | undefined) => {
    const readiness = buildReadiness({ ...ROBOT_ROOM, calibrationKind });
    return projectObservationStatusV1(
      projectRemoteStatus(remoteFacts({ readiness })),
      { micLeaseHeld: false, micSampleRate: null },
    ).calibration.kind;
  };
  assert.equal(kindFor('boot-probe'), 'boot-probe');
  assert.equal(kindFor('content'), 'content');
  assert.equal(kindFor('none'), 'none');
  assert.equal(kindFor(undefined), 'none');
  assert.equal(kindFor('legacy-manual'), 'none');
});

function productFacts(overrides: Partial<ProductStatusFacts> = {}): ProductStatusFacts {
  const facts: ProductStatusFacts = {
    readiness: buildReadiness(ROBOT_ROOM),
    participantCount: 2,
    micOwnerId: 'participant-a',
    micOwnerNickname: 'A',
    publisherControlConnected: true,
    freshMicUplink: null,
    micAudibilityDegraded: false,
    micLevelWarning: null,
    robotPlayerError: null,
    room: { videoId: 'song-1', connected: true, state: 1, handoffState: 'idle' },
    timelineAgeMs: 40,
    takeStatus: { type: 'take-status', lifecycle: 'idle', take: null, history: [] },
    timing: {
      calibratedMicLagMs: 210,
      calibrationState: 'complete',
      calibrationActive: false,
      calibrationStale: false,
      requestedMicAdvanceMs: 210,
      appliedMicAdvanceMs: 210,
      micFrontierCorrectionMs: 0,
      robotRouteActive: true,
      appliedCalibrationKind: 'boot-probe',
      robotProbeTimingActive: true,
      bootProbeActive: false,
      contentEvidenceReady: true,
      robotDeltaFresh: true,
    },
  };
  return { ...facts, ...overrides };
}

function withTiming(timing: Partial<ProductStatusFacts['timing']>, overrides: Partial<ProductStatusFacts> = {}) {
  const facts = productFacts(overrides);
  return { ...facts, timing: { ...facts.timing, ...timing } };
}

test('product timing needs a fresh Robot delta only while a boot-probe alignment is serving', () => {
  assert.equal(projectProductStatus(productFacts()).timing.state, 'aligned');

  // The probe measured against the Robot's player, so its alignment holds only
  // while the player delta is fresh.
  assert.equal(
    projectProductStatus(withTiming({ robotDeltaFresh: false })).timing.state,
    'fallback',
  );
  // A content alignment measured the song itself: the delta is irrelevant. The
  // fact is the kind applied to the mixer, so a replacement probe measuring in
  // the background cannot reclassify the alignment that is serving.
  assert.equal(
    projectProductStatus(withTiming({ robotDeltaFresh: false, appliedCalibrationKind: 'content' })).timing.state,
    'aligned',
  );
  // Off the Robot route there is no player delta to need.
  assert.equal(
    projectProductStatus(withTiming({ robotDeltaFresh: false, robotRouteActive: false })).timing.state,
    'aligned',
  );
});

test('product timing calls a half-millisecond clamp clamped, and blames a lagging frontier on the Mic', () => {
  assert.equal(
    projectProductStatus(withTiming({ appliedMicAdvanceMs: 209.6 })).timing.state,
    'aligned',
  );

  const clamped = projectProductStatus(withTiming({ appliedMicAdvanceMs: 209.5 }));
  assert.equal(clamped.timing.state, 'clamped');
  const clampIssue = clamped.issues.find((issue) => issue.code === 'timing-clamped');
  assert.equal(clampIssue?.cause, 'timing-clamped');
  assert.equal(clampIssue?.recovery, 'recalibrate');

  const lagging = projectProductStatus(withTiming({ appliedMicAdvanceMs: 120, micFrontierCorrectionMs: 0.5 }));
  const lagIssue = lagging.issues.find((issue) => issue.code === 'timing-clamped');
  assert.equal(lagIssue?.cause, 'mic-frontier-lagging');
  assert.equal(lagIssue?.recovery, 'retry-mic');

  assert.equal(
    projectProductStatus(withTiming({ calibratedMicLagMs: null })).timing.state,
    'fallback',
    'without an acoustic measurement the room is on the network estimate',
  );
});

test('one fresh Mic health report owns every browser-quality fact in ProductStatus', () => {
  const report = (fields: Record<string, unknown>) => ({
    transport: { mediaRecoveryDegraded: false },
    captureClipping: { recentDetected: false },
    ...fields,
  }) as unknown as ProductStatusFacts['freshMicUplink'];
  const micIssues = (freshMicUplink: ProductStatusFacts['freshMicUplink']) => projectProductStatus(
    productFacts({ freshMicUplink }),
  ).issues.filter((issue) => issue.scope === 'mic').map((issue) => issue.cause);

  assert.deepEqual(micIssues(report({})), []);
  assert.deepEqual(
    micIssues(report({ transport: { mediaRecoveryDegraded: true } })),
    ['mic-audio-stalled'],
  );
  assert.deepEqual(
    micIssues(report({ captureClipping: { recentDetected: true } })),
    ['mic-input-clipping'],
  );
  // No fresh report means no browser verdict at all, not a stale one.
  assert.deepEqual(micIssues(null), []);
});

test('a Robot player error blocks only the video the room is on', () => {
  const robotIssue = (robotPlayerError: ProductStatusFacts['robotPlayerError']) => projectProductStatus(
    productFacts({ robotPlayerError }),
  ).issues.find((issue) => issue.scope === 'robot') ?? null;

  const blocked = robotIssue({ videoId: 'song-1', code: 150 });
  assert.equal(blocked?.cause, 'robot-video-unplayable');
  assert.equal(blocked?.recovery, 'change-song');
  assert.equal(robotIssue({ videoId: 'previous-song', code: 150 }), null);
  assert.equal(robotIssue({ videoId: 'song-1', code: 5 }), null);
  assert.equal(robotIssue(null), null);
});

test('ProductStatus reads the room Song defensively', () => {
  const status = projectProductStatus(productFacts({
    room: { videoId: '', connected: 0, state: 'unknown', handoffState: undefined },
    timelineAgeMs: Number.NaN,
  }));
  assert.deepEqual(status.room.song, { state: 'empty', videoId: null, handoffState: 'idle' });

  const loaded = projectProductStatus(productFacts({ room: { videoId: 'song-1', handoffState: 'committing' } }));
  assert.equal(loaded.room.song.videoId, 'song-1');
  assert.equal(loaded.room.song.handoffState, 'committing');
  assert.equal(loaded.lifecycle, 'preparing');
});
