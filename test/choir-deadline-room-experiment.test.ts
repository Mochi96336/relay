import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ChoirDeadlineRoomExperiment } from '../src/choir-deadline-room-experiment.js';

const RATE = 48_000;
const FRAME = 960;
const room = (catchup = 8) => new ChoirDeadlineRoomExperiment({
  sampleRate: RATE, frameMs: 20,
  prebufferMs: 400, retentionMs: 3_000,
  roomEpochMs: 0, outputHoldbackMs: 200,
  songEpoch: 7, backingGeneration: 9,
  maxCatchupFrames: catchup, reconnectGraceMs: 2_000,
});
const captured = (size: number, amplitude: number, start = 0, generation = 1) => ({
  generation, firstSampleIndex: start,
  pcm: Buffer.from(new Int16Array(size).fill(amplitude).buffer),
});
function admitBoth(coordinator: ChoirDeadlineRoomExperiment) {
  const a = coordinator.admitTrusted({
    verifiedParticipantId: 'A', transportId: 'socket-A',
    seat: 'primary', expectedPrimaryId: null, nowMs: 0,
  });
  const b = coordinator.admitTrusted({
    verifiedParticipantId: 'B', transportId: 'socket-B',
    seat: 'secondary', expectedPrimaryId: 'A', nowMs: 0,
  });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  if (!a.ok || !b.ok) throw Error('test fixture admission');
  return { a, b };
}

describe('fixed-deadline canonical N=2 room, trusted server-only ingress', () => {
  test('two verified independent transports both reach one room output at exactly due time', () => {
    const coordinator = room();
    const { a, b } = admitBoth(coordinator);
    assert.notEqual(a.mediaEpoch, b.mediaEpoch);
    assert.equal(coordinator.registry.activePublisherForTransport('socket-B')?.participantId, 'B');
    assert.equal(coordinator.receiveFromTransport('socket-A', captured(FRAME * 5, 6_000), RATE, 100), true);
    assert.equal(coordinator.receiveFromTransport('socket-B', captured(FRAME * 5, 9_000), RATE, 100), true);
    assert.equal(coordinator.renderDue(219.999).state, 'not-due');
    const first = coordinator.renderDue(220);
    assert.equal(first.state, 'ready');
    if (first.state !== 'ready') return;
    assert.equal(first.frames.length, 1);
    assert.equal(first.frames[0].roomStartSample, 0);
    assert.equal(first.frames[0].singers[0].participantId, 'A');
    assert.equal(first.frames[0].singers[1].participantId, 'B');
    assert.equal(first.frames[0].singers[0].gapSamples, 0);
    assert.equal(first.frames[0].singers[1].gapSamples, 0);
    assert.ok(first.frames[0].pcm[500] > 0, 'real canonical mixed PCM is emitted');
    assert.equal(coordinator.outputSampleCursor, FRAME);
    assert.equal(coordinator.renderDue(220).state, 'not-due');
    const second = coordinator.renderDue(240);
    assert.equal(second.state, 'ready');
    if (second.state === 'ready') {
      assert.equal(second.frames[0].roomStartSample, FRAME);
    }
    assert.equal(coordinator.outputSampleCursor, FRAME * 2);
  });

  test('unrecognized, closed and replaced transports cannot impersonate either singer', () => {
    const coordinator = room();
    const { a, b } = admitBoth(coordinator);
    assert.equal(coordinator.receiveFromTransport('socket-C',
      captured(FRAME, 7_000), RATE, 20), false);
    assert.equal(coordinator.disconnectTransport('socket-A', 30), true);
    assert.equal(coordinator.receiveFromTransport('socket-A',
      captured(FRAME, 7_000), RATE, 40), false);
    assert.equal(coordinator.disconnectTransport('socket-A', 40), false);
    assert.equal(coordinator.receiveFromTransport('socket-B',
      captured(FRAME * 5, 9_000), RATE, 100), true);
    assert.equal(coordinator.seats.primaryMicId, 'A',
      'disconnect does not promote the secondary');
    assert.equal(coordinator.seats.seatOf('B'), 'secondary');
    const result = coordinator.renderDue(220);
    assert.equal(result.state, 'ready');
    if (result.state === 'ready') {
      assert.equal(result.frames[0].singers[0].expected, false);
      assert.equal(result.frames[0].singers[1].expected, true);
      assert.ok(result.frames[0].pcm[500] > 0);
    }
    assert.equal(coordinator.registry.mayAcceptMedia('A', 'socket-A', a.mediaEpoch), false);
    assert.equal(coordinator.registry.mayAcceptMedia('B', 'socket-B', b.mediaEpoch), true);
  });

  test('explicit transport rebind fails closed until safe capture-tail replacement exists', () => {
    const coordinator = room();
    const { a, b } = admitBoth(coordinator);
    assert.deepEqual(coordinator.admitTrusted({
      verifiedParticipantId: 'A', transportId: 'socket-A',
      seat: 'primary', expectedPrimaryId: 'A', nowMs: 10,
    }), { ok: true, mediaEpoch: a.mediaEpoch, idempotent: true });
    assert.equal(coordinator.disconnectTransport('socket-A', 20), true);
    assert.deepEqual(coordinator.admitTrusted({
      verifiedParticipantId: 'A', transportId: 'socket-A-new',
      seat: 'primary', expectedPrimaryId: 'A', nowMs: 30,
    }), { ok: false, reason: 'rebind-deferred' });
    assert.equal(coordinator.registry.activePublisherForTransport('socket-A-new'), null);
    assert.equal(coordinator.registry.mayAcceptMedia('B', 'socket-B', b.mediaEpoch), true);
  });

  test('timer stalls beyond bounded catch-up never replay old singing', () => {
    const coordinator = room(3);
    admitBoth(coordinator);
    coordinator.receiveFromTransport('socket-A', captured(FRAME * 15, 8_000), RATE, 300);
    const result = coordinator.renderDue(340); // 7 frames due, cap is 3
    assert.deepEqual(result, {
      state: 'resync-required', frames: [], reason: 'late-clock',
    });
    assert.equal(coordinator.outputSampleCursor, 0, 'no expired PCM emitted');
    assert.equal(coordinator.receiveFromTransport('socket-A',
      captured(FRAME, 8_000, FRAME * 15), RATE, 350), false);
    assert.deepEqual(coordinator.renderDue(360), result,
      'a failed deadline must never silently return to a stale epoch');
  });

  test('wall-clock regression invalidates room before it can rewind playback', () => {
    const coordinator = room();
    admitBoth(coordinator);
    assert.equal(coordinator.renderDue(219).state, 'not-due');
    assert.deepEqual(coordinator.renderDue(100), {
      state: 'resync-required', frames: [], reason: 'time-regression',
    });
    assert.equal(coordinator.outputSampleCursor, 0);
  });

  test('no packet can create a secondary or steal primary without trusted admission', () => {
    const coordinator = room();
    assert.equal(coordinator.receiveFromTransport('socket-B',
      captured(FRAME, 10_000), RATE, 20), false);
    assert.equal(coordinator.admitTrusted({
      verifiedParticipantId: 'B', transportId: 'socket-B',
      seat: 'secondary', expectedPrimaryId: null, nowMs: 10,
    }).ok, false, 'primary must be deliberately admitted first');
    const a = coordinator.admitTrusted({
      verifiedParticipantId: 'A', transportId: 'socket-A',
      seat: 'primary', expectedPrimaryId: null, nowMs: 10,
    });
    assert.equal(a.ok, true);
    const attempted = coordinator.admitTrusted({
      verifiedParticipantId: 'B', transportId: 'socket-B',
      seat: 'primary', expectedPrimaryId: null, nowMs: 11,
    });
    assert.equal(attempted.ok, false, 'no implicit Take Mic');
    assert.equal(coordinator.seats.primaryMicId, 'A');
  });
});
