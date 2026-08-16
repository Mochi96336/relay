import assert from 'node:assert/strict';
import test from 'node:test';

import { buildProductViewModel } from '../src/product-view-model.js';
import { buildReadiness, type ReadinessInput } from '../src/readiness.js';
import { TakeQualityTracker } from '../src/take-quality.js';
import { TakeSession } from '../src/take-session.js';

const VOICE_ONLY: ReadinessInput = {
  routeMode: 'idle',
  backingConnected: false,
  backingStreaming: false,
  backingSampleRate: null,
  backingIsRobot: false,
  micConnected: true,
  micStreaming: true,
  robotSourceConnected: false,
  sessionActive: true,
  timelineConnected: false,
  timelineState: null,
  playerOffsetMs: null,
  playerOffsetFresh: false,
  calibrationState: 'idle',
  calibrationValid: false,
  calibrationStale: false,
  calibrationKind: 'none',
  probeCorrelation: { mic: null, backing: null },
  bootCalibration: null,
};

test('voice-only session readiness does not require Song timeline or calibration', () => {
  const readiness = buildReadiness(VOICE_ONLY);
  assert.equal(readiness.ready, true);
  assert.equal(readiness.sessionReady, true);
  assert.deepEqual(readiness.reasons, []);
  assert.deepEqual(readiness.sessionReasons, []);
  assert.equal(readiness.components.route.mode, 'idle');
});

test('product lifecycle and Take availability treat live Mic as a complete voice-only room', () => {
  const status = buildProductViewModel({
    readiness: buildReadiness(VOICE_ONLY),
    participantCount: 1,
    micOwnerId: 'participant-a',
    micOwnerNickname: 'A',
    roomSong: { videoId: null, connected: false, state: null, handoffState: 'idle' },
    take: { lifecycle: 'idle', takeId: null, qualityVerdict: null },
    timing: {
      timingMode: 'network-estimate',
      calibrationState: 'idle',
      calibrationStale: false,
      alignmentClamped: false,
      robotRoute: false,
      robotDeltaFresh: false,
    },
  });

  assert.equal(status.lifecycle, 'live');
  assert.equal(status.health, 'healthy');
  assert.equal(status.room.song.state, 'empty');
  assert.equal(status.timing.state, 'idle');
  assert.equal(status.actions.canStartTake, true);
});

test('voice-only Take snapshot explicitly records that there was no Song', () => {
  const takes = new TakeSession();
  const started = takes.start({
    takeId: 'voice-only',
    startedByParticipantId: 'participant-a',
    song: { videoId: null, revision: null, state: null, serverTime: null, playbackRate: null },
    startedAtMs: 1_000,
  });
  assert.equal(started.ok, true);
  assert.equal(takes.currentTake()?.song.videoId, null);
});

test('voice-only quality ignores intentionally absent backing and timing evidence', () => {
  const tracker = new TakeQualityTracker({
    sampleRate: 48_000,
    backingExpected: false,
    timingExpected: false,
  });
  tracker.observeFrame(960, {
    timingMode: 'network-estimate',
    calibrationStale: true,
    alignmentClamped: true,
    robotRoute: true,
    robotDeltaFresh: false,
  }, {
    micGapSamples: 0,
    backingGapSamples: 960,
    micStarvedSamples: 0,
    backingStarvedSamples: 960,
    micUnavailableSamples: 0,
    backingUnavailableSamples: 960,
    clippedSamples: 0,
    limitedSamples: 0,
    unheaderedSamples: 0,
  });
  tracker.noteEvent('backing-transport-disconnected');
  tracker.noteEvent('robot-source-disconnected');

  const quality = tracker.assessment();
  assert.equal(quality.verdict, 'clean');
  assert.equal(quality.evidence.backingUnavailableMs, 0);
  assert.equal(quality.evidence.networkEstimateMs, 0);
  assert.equal(quality.evidence.calibrationStaleMs, 0);
  assert.equal(quality.evidence.events['backing-transport-disconnected'], 0);
  assert.equal(quality.evidence.events['robot-source-disconnected'], 0);
});
