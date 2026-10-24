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

  test('has no timing to recover while nobody holds the Mic', () => {
    const freeMic = {
      readiness: readiness({
        micConnected: false,
        micStreaming: false,
        micFlowObserved: false,
        calibrationValid: false,
      }),
      micOwnerId: null,
      micOwnerNickname: null,
      timing: {
        timingMode: 'network-estimate' as const,
        calibrationState: 'idle',
        calibrationStale: true,
        alignmentClamped: true,
        requiresRobotPlayerDelta: true,
        robotDeltaFresh: false,
      },
    };
    const model = buildProductViewModel(input(freeMic));

    assert.equal(model.lifecycle, 'live', 'the song is still playing to the room');
    assert.equal(model.timing.state, 'idle');
    assert.deepEqual(model.issues, []);
    assert.equal(model.health, 'healthy');

    const measuring = buildProductViewModel(input({
      ...freeMic,
      timing: { ...freeMic.timing, calibrationActive: true },
    }));
    assert.equal(measuring.timing.state, 'calibrating', 'a measurement in flight is still reported');

    const held = buildProductViewModel(input({ ...freeMic, micOwnerId: 'participant-a' }));
    assert.equal(held.timing.state, 'clamped', 'the same timing matters once someone holds the Mic');
  });

  test('turns a prepared playback handoff into preparing without calling it unhealthy', () => {
    const model = buildProductViewModel(input({
      roomSong: { videoId: 'abcdefghijk', connected: true, clockAgeMs: 0, state: 1, handoffState: 'preparing' },
    }));

    assert.equal(model.lifecycle, 'preparing');
    assert.equal(model.health, 'healthy');
    assert.equal(model.room.song.state, 'handoff');
  });

  test('turns an audible boot probe into preparing rather than degradation', () => {
    const model = buildProductViewModel(input({
      readiness: readiness({ calibrationState: 'idle', calibrationValid: false }),
      timing: {
        timingMode: 'network-estimate',
        calibrationState: 'idle',
        calibrationActive: true,
        bootProbeActive: true,
        calibrationStale: false,
        alignmentClamped: false,
        requiresRobotPlayerDelta: true,
        robotDeltaFresh: false,
      },
    }));

    assert.equal(model.lifecycle, 'preparing');
    assert.equal(model.health, 'healthy');
    assert.equal(model.timing.state, 'calibrating');
    assert.equal(model.actions.canStartTake, false);
    assert.equal(model.actions.startTakeBlockedReason, 'timing-calibration-active');
  });

  test('leaves the room live while a background content measurement runs', () => {
    // Content calibration only listens to audio the room is already making.
    // Presenting a singing room as getting ready - or refusing a Take - would
    // describe the measurement rather than the room.
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

    assert.equal(model.lifecycle, 'live');
    assert.equal(model.timing.state, 'calibrating');
    assert.equal(model.actions.canStartTake, true);
    assert.equal(model.actions.startTakeBlockedReason, null);
  });

  test('reports the alignment being served, not the replacement being measured', () => {
    // CalibrationSession deliberately keeps the confirmed result serving while
    // a replacement collects, so the room's timing state is that applied
    // authority - reading the candidate would call an aligned room unready.
    const model = buildProductViewModel(input({
      readiness: readiness({ calibrationState: 'collecting' }),
      timing: {
        timingMode: 'acoustic-calibration',
        calibrationState: 'collecting',
        calibrationStale: false,
        alignmentClamped: false,
        requiresRobotPlayerDelta: true,
        robotDeltaFresh: true,
      },
    }));

    assert.equal(model.lifecycle, 'live');
    assert.equal(model.health, 'healthy');
    assert.equal(model.timing.state, 'aligned');
    assert.equal(model.actions.canStartTake, true);
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
    assert.deepEqual(model.issues.find(issue => issue.code === 'song-clock-unavailable')?.affects,
      ['timing', 'recording']);
    assert.equal(model.actions.canStartTake, false);
    assert.equal(model.actions.startTakeBlockedReason, 'room-blocked');
  });

  test('handoff preparation cannot downgrade an active moving-song clock blocker', () => {
    for (const state of [1, 3]) {
      for (const handoffState of ['preparing', 'committing']) {
        const model = buildProductViewModel(input({
          readiness: readiness({ timelineConnected: false, timelineState: state, sessionActive: true }),
          roomSong: { videoId: 'abcdefghijk', connected: false, clockAgeMs: 15_001, state, handoffState },
        }));
        assert.equal(model.lifecycle, 'preparing');
        assert.equal(model.room.song.state, 'handoff');
        assert.equal(model.health, 'blocked');
        const issue = model.issues.find(issue => issue.code === 'song-clock-unavailable');
        assert.equal(issue?.severity, 'critical');
        assert.deepEqual(issue?.affects, ['timing', 'recording']);
        assert.equal(model.actions.canStartTake, false);
        assert.equal(model.actions.startTakeBlockedReason, 'room-blocked');
        assert.deepEqual(model.actions.startTakeBlockingIssue, issue);
      }
    }
  });

  test('handoff clock protection keeps its age, media-state and session boundaries', () => {
    for (const [state, clockAgeMs, sessionActive, severity] of [
      [1, 6_000, true, null],
      [1, 6_001, true, 'warning'],
      [1, 15_000, true, 'warning'],
      [1, 15_001, false, 'warning'],
      [2, 30_000, true, null],
      [5, 30_000, true, null],
    ] as const) {
      const model = buildProductViewModel(input({
        readiness: readiness({ timelineConnected: false, timelineState: state, sessionActive }),
        roomSong: { videoId: 'abcdefghijk', connected: false, clockAgeMs, state, handoffState: 'preparing' },
      }));
      assert.equal(model.issues.find(issue => issue.code === 'song-clock-unavailable')?.severity ?? null, severity);
      assert.equal(model.health, severity ? 'degraded' : 'healthy');
      assert.equal(model.actions.canStartTake, sessionActive);
    }
  });

  test('an offline paused controller is not a playback failure even after a long gap', () => {
    for (const state of [-1, 0, 2, 5]) {
      const model = buildProductViewModel(input({
        micOwnerId: null,
        micOwnerNickname: null,
        readiness: readiness({ timelineConnected: false, timelineState: state, micConnected: false, micStreaming: false }),
        roomSong: { videoId: 'abcdefghijk', connected: false, clockAgeMs: 12 * 60_000, state, handoffState: 'idle' },
      }));
      assert.equal(model.health, 'healthy', `state ${state}`);
      assert.equal(model.attention, null);
      assert.equal(model.room.song.state, 'ready');
    }
  });

  test('dormant clock exemption preserves observed backing and video failures', () => {
    for (const [overrides, cause] of [
      [{ readiness: readiness({ timelineState: 2, backingStreaming: false }) }, 'backing-stalled'],
      [{ readiness: readiness({ timelineState: 2, robotSourceConnected: false }) }, 'robot-source-unavailable'],
      [{ robotVideoUnplayable: true }, 'robot-video-unplayable'],
    ] as const) {
      const model = buildProductViewModel(input({
        ...overrides,
        roomSong: { videoId: 'abcdefghijk', connected: false, clockAgeMs: 12 * 60_000, state: 2, handoffState: 'idle' },
      }));
      assert.ok(!model.issues.some(issue => issue.code === 'song-clock-unavailable'));
      assert.ok(model.issues.some(issue => issue.cause === cause && issue.severity === 'critical'));
      assert.equal(model.health, 'blocked');
      assert.equal(model.actions.canStartTake, false);
    }
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

  test('a held boot measurement is still the alignment being served, not a fallback', () => {
    // calibration-applicability holds an established boot result while the
    // Robot's player delta is quiet, and the mixer keeps applying it.
    const model = buildProductViewModel(input({
      readiness: readiness({ playerOffsetMs: null, playerOffsetFresh: false }),
      timing: {
        timingMode: 'acoustic-calibration',
        calibrationState: 'complete',
        calibrationStale: false,
        alignmentClamped: false,
        requiresRobotPlayerDelta: true,
        robotDeltaFresh: false,
      },
    }));

    assert.equal(model.timing.state, 'aligned');
    assert.equal(model.timing.syncHeld, true);
    assert.equal(model.issues.find((issue) => issue.scope === 'timing'), undefined);
  });

  test('a revoked measurement that left the mixer on the estimate is still a fallback', () => {
    const model = buildProductViewModel(input({
      readiness: readiness({ playerOffsetMs: null, playerOffsetFresh: false }),
      timing: {
        timingMode: 'network-estimate',
        calibrationState: 'complete',
        calibrationStale: false,
        alignmentClamped: false,
        requiresRobotPlayerDelta: true,
        robotDeltaFresh: false,
      },
    }));

    assert.equal(model.timing.state, 'fallback');
    assert.equal(model.timing.syncHeld, false);
  });

  test('timing advice during a Take waits for the recording instead of offering a refused Realign', () => {
    const model = buildProductViewModel(input({
      readiness: readiness({ calibrationValid: false, calibrationKind: 'none' }),
      take: { lifecycle: 'recording', takeId: 'take-1', qualityVerdict: null },
      timing: {
        timingMode: 'network-estimate',
        calibrationState: 'failed',
        calibrationStale: false,
        alignmentClamped: false,
        requiresRobotPlayerDelta: true,
        robotDeltaFresh: true,
      },
    }));

    assert.equal(model.actions.canStartCalibration, false);
    assert.equal(model.actions.startCalibrationBlockedReason, 'take-active');
    assert.equal(model.issues.find((issue) => issue.scope === 'timing')?.recovery, 'recalibrate-after-take');

    const afterTake = buildProductViewModel(input({
      readiness: readiness({ calibrationValid: false, calibrationKind: 'none' }),
      timing: {
        timingMode: 'network-estimate',
        calibrationState: 'failed',
        calibrationStale: false,
        alignmentClamped: false,
        requiresRobotPlayerDelta: true,
        robotDeltaFresh: true,
      },
    }));
    assert.equal(afterTake.issues.find((issue) => issue.scope === 'timing')?.recovery, 'recalibrate');
  });

  test('a Mic that never heard the boot chime is an estimate, and Realign is advice for speakers', () => {
    const base = {
      readiness: readiness({ calibrationValid: false, calibrationKind: 'none' }),
      timing: {
        timingMode: 'network-estimate' as const,
        calibrationState: 'failed',
        calibrationStale: false,
        alignmentClamped: false,
        requiresRobotPlayerDelta: false,
        robotDeltaFresh: true,
        micProbeUnheard: true,
      },
    };
    const model = buildProductViewModel(input(base));
    const issue = model.issues.find((candidate) => candidate.scope === 'timing');
    assert.equal(model.timing.state, 'fallback');
    assert.equal(issue?.cause, 'timing-probe-unheard');
    assert.equal(issue?.recovery, 'recalibrate-speaker');

    const recording = buildProductViewModel(input({
      ...base,
      take: { lifecycle: 'recording', takeId: 'take-1', qualityVerdict: null },
    }));
    assert.equal(recording.issues.find((candidate) => candidate.scope === 'timing')?.recovery, 'recalibrate-after-take');

    const heard = buildProductViewModel(input({ ...base, timing: { ...base.timing, micProbeUnheard: false } }));
    assert.equal(heard.issues.find((candidate) => candidate.scope === 'timing')?.cause, 'timing-fallback');
  });

});
