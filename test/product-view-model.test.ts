import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { buildProductViewModel, type ProductViewModelInput } from '../src/product-view-model.js';
import { buildReadiness, type ReadinessInput } from '../src/readiness.js';

const READY: ReadinessInput = {
  backingConnected: true,
  backingStreaming: true,
  backingSampleRate: 48_000,
  backingIsRobot: true,
  micConnected: true,
  micStreaming: true,
  robotSourceConnected: true,
  sessionActive: true,
  timelineConnected: true,
  timelineState: 1,
  playerOffsetMs: 12,
  playerOffsetFresh: true,
  calibrationState: 'complete',
  calibrationValid: true,
  calibrationStale: false,
  calibrationKind: 'boot-probe',
  probeCorrelation: { mic: 0.8, backing: 0.9 },
  bootCalibration: { advanceMs: 20 },
};

function input(overrides: Partial<ProductViewModelInput> = {}): ProductViewModelInput {
  const base: ProductViewModelInput = {
    readiness: buildReadiness(READY),
    participantCount: 1,
    micOwnerId: 'participant-alice',
    micOwnerNickname: 'Alice',
    roomSong: {
      videoId: 'abcdefghijk',
      connected: true,
      clockAgeMs: 0,
      state: 1,
      handoffState: 'idle',
    },
    take: {
      lifecycle: 'idle',
      takeId: null,
      qualityVerdict: null,
    },
    timing: {
      timingMode: 'acoustic-calibration',
      calibrationState: 'complete',
      calibrationStale: false,
      alignmentClamped: false,
      requiresRobotPlayerDelta: true,
      robotDeltaFresh: true,
    },
  };
  return {
    ...base,
    ...overrides,
    roomSong: { ...base.roomSong, ...overrides.roomSong },
    take: { ...base.take, ...overrides.take },
    timing: { ...base.timing, ...overrides.timing },
  };
}

function readiness(overrides: Partial<ReadinessInput>) {
  return buildReadiness({ ...READY, ...overrides });
}

describe('product lifecycle and health', () => {
  test('treats an idle healthy robot as healthy even though session readiness is incomplete', () => {
    const model = buildProductViewModel(input({
      readiness: readiness({
        micConnected: false,
        micStreaming: false,
        sessionActive: false,
        timelineConnected: false,
        timelineState: null,
        playerOffsetFresh: false,
        calibrationState: 'idle',
        calibrationValid: false,
      }),
      micOwnerId: null,
      micOwnerNickname: null,
      roomSong: { videoId: null, connected: false, clockAgeMs: 0, state: null, handoffState: 'idle' },
      timing: {
        timingMode: 'network-estimate',
        calibrationState: 'idle',
        calibrationStale: false,
        alignmentClamped: false,
        requiresRobotPlayerDelta: true,
        robotDeltaFresh: false,
      },
    }));

    assert.equal(model.lifecycle, 'idle');
    assert.equal(model.health, 'healthy');
    assert.equal(model.attention, null);
    assert.equal(model.room.mic.state, 'free');
  });

  test('blocks the product when robot backing audio is unavailable even while idle', () => {
    const model = buildProductViewModel(input({
      readiness: readiness({
        backingConnected: false,
        backingStreaming: false,
        micConnected: false,
        micStreaming: false,
        sessionActive: false,
        timelineConnected: false,
        timelineState: null,
        playerOffsetFresh: false,
        calibrationValid: false,
      }),
      micOwnerId: null,
      micOwnerNickname: null,
      roomSong: { videoId: null, connected: false, clockAgeMs: 0, state: null, handoffState: 'idle' },
    }));

    assert.equal(model.lifecycle, 'idle');
    assert.equal(model.health, 'blocked');
    assert.equal(model.attention?.code, 'robot-audio-unavailable');
  });

  test('reports a loaded paused room as ready without treating phone-not-playing as damage', () => {
    const model = buildProductViewModel(input({
      readiness: readiness({ timelineState: 2, calibrationValid: false }),
      roomSong: { videoId: 'abcdefghijk', connected: true, clockAgeMs: 0, state: 2, handoffState: 'idle' },
      timing: {
        timingMode: 'network-estimate',
        calibrationState: 'idle',
        calibrationStale: false,
        alignmentClamped: false,
        requiresRobotPlayerDelta: true,
        robotDeltaFresh: false,
      },
    }));

    assert.equal(model.lifecycle, 'ready');
    assert.equal(model.health, 'healthy');
    assert.equal(model.room.song.state, 'ready');
    assert.equal(model.timing.state, 'idle');
  });

  test('reports normal performance as live and healthy', () => {
    const model = buildProductViewModel(input());
    assert.equal(model.lifecycle, 'live');
    assert.equal(model.health, 'healthy');
    assert.equal(model.room.mic.state, 'live');
    assert.equal(model.room.song.state, 'playing');
    assert.equal(model.timing.state, 'aligned');
  });

  test('keeps live lifecycle while a held microphone transport reconnects', () => {
    const model = buildProductViewModel(input({
      readiness: readiness({ micConnected: false, micStreaming: false }),
    }));

    assert.equal(model.lifecycle, 'live');
    assert.equal(model.health, 'degraded');
    assert.equal(model.attention?.code, 'mic-reconnecting');
    assert.equal(model.room.mic.state, 'reconnecting');
  });

  test('does not warn about a missing microphone when the lease is free', () => {
    const model = buildProductViewModel(input({
      readiness: readiness({ micConnected: false, micStreaming: false }),
      micOwnerId: null,
      micOwnerNickname: null,
    }));

    assert.equal(model.lifecycle, 'live');
    assert.equal(model.health, 'healthy');
    assert.equal(model.room.mic.state, 'free');
  });

  test('turns a prepared playback handoff into preparing without calling it unhealthy', () => {
    const model = buildProductViewModel(input({
      roomSong: { videoId: 'abcdefghijk', connected: true, clockAgeMs: 0, state: 1, handoffState: 'preparing' },
    }));

    assert.equal(model.lifecycle, 'preparing');
    assert.equal(model.health, 'healthy');
    assert.equal(model.room.song.state, 'handoff');
  });

  test('turns normal calibration collection into preparing rather than degradation', () => {
    const model = buildProductViewModel(input({
      readiness: readiness({ calibrationState: 'collecting', calibrationValid: false }),
      timing: {
        timingMode: 'network-estimate',
        calibrationState: 'collecting',
        calibrationStale: false,
        alignmentClamped: false,
        requiresRobotPlayerDelta: true,
        robotDeltaFresh: false,
      },
    }));

    assert.equal(model.lifecycle, 'preparing');
    assert.equal(model.health, 'healthy');
    assert.equal(model.timing.state, 'calibrating');
  });

  test('keeps recording as the primary lifecycle while timing falls back', () => {
    const model = buildProductViewModel(input({
      readiness: readiness({ playerOffsetFresh: false, calibrationValid: false }),
      take: { lifecycle: 'recording', takeId: 'take-1', qualityVerdict: null },
      timing: {
        timingMode: 'network-estimate',
        calibrationState: 'idle',
        calibrationStale: false,
        alignmentClamped: false,
        requiresRobotPlayerDelta: true,
        robotDeltaFresh: false,
      },
    }));

    assert.equal(model.lifecycle, 'recording');
    assert.equal(model.health, 'degraded');
    assert.equal(model.attention?.code, 'timing-recovering');
    assert.equal(model.timing.state, 'fallback');
    assert.equal(model.actions.canStopTake, true);
  });

  test('surfaces an impossible timing correction as a product warning', () => {
    const model = buildProductViewModel(input({
      timing: {
        timingMode: 'acoustic-calibration',
        calibrationState: 'complete',
        calibrationStale: false,
        alignmentClamped: true,
        requiresRobotPlayerDelta: true,
        robotDeltaFresh: true,
      },
    }));

    assert.equal(model.lifecycle, 'live');
    assert.equal(model.health, 'degraded');
    assert.equal(model.attention?.code, 'timing-clamped');
    assert.equal(model.timing.state, 'clamped');
  });

  test('blocks an active room when its authoritative song clock disappears', () => {
    const model = buildProductViewModel(input({
      readiness: readiness({ timelineConnected: false }),
      roomSong: { videoId: 'abcdefghijk', connected: false, clockAgeMs: 30_000, state: 1, handoffState: 'idle' },
    }));

    assert.equal(model.lifecycle, 'live');
    assert.equal(model.health, 'blocked');
    assert.equal(model.attention?.code, 'song-clock-unavailable');
    assert.equal(model.room.song.state, 'unavailable');
  });

  /**
   * The clock stops being authoritative after 1.5 s, which is right for
   * alignment and wrong as a thing to say to a singer. A phone reports every
   * 250 ms and misses five samples the moment its screen dims or the player
   * rebuffers, so at that window "playback unavailable" fires during ordinary
   * use - every time the singer glances away.
   */
  test('does not call playback unavailable while the singer glances away', () => {
    const model = buildProductViewModel(input({
      readiness: readiness({ timelineConnected: false }),
      roomSong: { videoId: 'abcdefghijk', connected: false, clockAgeMs: 2_000, state: 1, handoffState: 'idle' },
    }));

    assert.equal(model.attention, null);
    assert.equal(model.health, 'healthy');
    assert.notEqual(model.room.song.state, 'unavailable');
  });

  test('mentions a longer gap without blocking the performance for it', () => {
    const model = buildProductViewModel(input({
      readiness: readiness({ timelineConnected: false }),
      roomSong: { videoId: 'abcdefghijk', connected: false, clockAgeMs: 8_000, state: 1, handoffState: 'idle' },
    }));

    assert.equal(model.attention?.code, 'song-clock-unavailable');
    assert.equal(model.attention?.severity, 'warning');
    assert.equal(model.health, 'degraded');
  });

  test('keeps completed Take quality separate from current system health', () => {
    const model = buildProductViewModel(input({
      roomSong: { videoId: 'abcdefghijk', connected: true, clockAgeMs: 0, state: 2, handoffState: 'idle' },
      readiness: readiness({ timelineState: 2 }),
      take: { lifecycle: 'ready', takeId: 'take-1', qualityVerdict: 'degraded' },
    }));

    assert.equal(model.lifecycle, 'ready');
    assert.equal(model.health, 'healthy');
    assert.equal(model.take.verdict, 'degraded');
  });

  test('surfaces a failed Take without pretending the whole robot is blocked', () => {
    const model = buildProductViewModel(input({
      roomSong: { videoId: 'abcdefghijk', connected: true, clockAgeMs: 0, state: 2, handoffState: 'idle' },
      readiness: readiness({ timelineState: 2 }),
      take: { lifecycle: 'failed', takeId: 'take-1', qualityVerdict: 'review' },
    }));

    assert.equal(model.lifecycle, 'ready');
    assert.equal(model.health, 'degraded');
    assert.equal(model.attention?.code, 'take-failed');
  });

  test('content calibration stays session-ready without a Robot player delta', () => {
    const snapshot = readiness({
      playerOffsetMs: null,
      playerOffsetFresh: false,
      calibrationKind: 'content',
      calibrationValid: true,
    });

    assert.equal(snapshot.components.calibration.kind, 'content');
    assert.equal(snapshot.sessionReasons.includes('robot-player-offset-stale'), false);
  });

  test('Robot route identity does not require a player delta when the active timing strategy does not', () => {
    const model = buildProductViewModel(input({
      readiness: readiness({
        playerOffsetMs: null,
        playerOffsetFresh: false,
        calibrationValid: true,
      }),
      timing: {
        timingMode: 'acoustic-calibration',
        calibrationState: 'complete',
        calibrationStale: false,
        alignmentClamped: false,
        requiresRobotPlayerDelta: false,
        robotDeltaFresh: false,
      },
    }));

    assert.equal(model.lifecycle, 'live');
    assert.equal(model.timing.state, 'aligned');
    assert.equal(model.health, 'healthy');
    assert.equal(model.attention, null);
  });

});
