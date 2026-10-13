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
    assert.equal(coordinator.inspectTransport('socket-B')?.participantId, 'B');
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
    assert.equal(coordinator.snapshot().seats.primaryMicId, 'A',
      'disconnect does not promote the secondary');
    assert.equal(coordinator.snapshot().seats.secondaryMicIds.includes('B') ? 'secondary' : null, 'secondary');
    const result = coordinator.renderDue(220);
    assert.equal(result.state, 'ready');
    if (result.state === 'ready') {
      assert.equal(result.frames[0].singers[0].expected, false);
      assert.equal(result.frames[0].singers[1].expected, true);
      assert.ok(result.frames[0].pcm[500] > 0);
    }
    assert.equal(coordinator.inspectTransport('socket-A')?.mediaEpoch === a.mediaEpoch, false);
    assert.equal(coordinator.inspectTransport('socket-B')?.mediaEpoch === b.mediaEpoch, true);
  });

  test('late Mic arrival cannot enter an expired frame even when output tick is delayed', () => {
    const coordinator = room();
    admitBoth(coordinator);
    assert.equal(coordinator.receiveFromTransport('socket-A',
      captured(FRAME / 2, 5_000), RATE, 10), true);
    assert.equal(coordinator.receiveFromTransport('socket-B',
      captured(FRAME * 5, 6_000), RATE, 100), true);
    // Deliberately DO NOT call renderDue(220). The first event after that
    // deadline is a late A media packet, and the coordinator must seal the
    // immutable output frame before considering its PCM.
    assert.equal(coordinator.receiveFromTransport('socket-A',
      captured(FRAME / 2, 8_000, FRAME / 2), RATE, 221), false);
    assert.equal(coordinator.outputSampleCursor, FRAME,
      'the elapsed frame was sealed before processing the late packet');
    const ready = coordinator.renderDue(221);
    if (ready.state !== 'ready') throw Error('must drain sealed frame');
    assert.equal(ready.frames.length, 1);
    assert.equal(ready.frames[0].roomStartSample, 0);
    assert.equal(ready.frames[0].singers[0].frontierMissingSamples, FRAME / 2);
    assert.equal(ready.frames[0].singers[0].latePacketDrops, 0,
      'the count is captured when the frame seals; the next frame sees the rejection');
    const next = coordinator.renderDue(240);
    if (next.state !== 'ready') throw Error('next frame');
    assert.equal(next.frames[0].singers[0].latePacketDrops, 1);
    assert.equal(next.frames[0].singers[1].latePacketDrops, 0);
  });

  test('undelivered deadline FIFO is bounded even if media continues arriving', () => {
    const coordinator = room(2);
    admitBoth(coordinator);
    assert.equal(coordinator.renderDue(220).state, 'ready');
    assert.equal(coordinator.receiveFromTransport('socket-B',
      captured(FRAME, 7_000), RATE, 240), true);
    // At 240, one newly sealed frame remains queued because renderDue was
    // never called; at 280, 2 more due => 3 undelivered > maxCatchupFrames.
    assert.equal(coordinator.receiveFromTransport('socket-B',
      captured(FRAME, 7_000, FRAME), RATE, 280), false);
    assert.deepEqual(coordinator.renderDue(280), {
      state: 'resync-required', frames: [], reason: 'late-clock',
    });
  });

  test('a late packet cannot fill an already sealed Mic frame after deadline', () => {
    const coordinator = room();
    admitBoth(coordinator);
    assert.equal(coordinator.receiveFromTransport('socket-A',
      captured(FRAME / 2, 5_000), RATE, 10), true);
    assert.equal(coordinator.receiveFromTransport('socket-B',
      captured(FRAME * 5, 6_000), RATE, 100), true);
    const first = coordinator.renderDue(220);
    if (first.state !== 'ready') throw new Error('due');
    assert.equal(first.frames[0].singers[0].frontierMissingSamples, FRAME / 2);
    assert.equal(coordinator.receiveFromTransport('socket-A',
      captured(FRAME / 2, 8_000, FRAME / 2), RATE, 221), false,
      'late A samples cannot retroactively change the emitted room frame');
    const second = coordinator.renderDue(240);
    if (second.state !== 'ready') throw Error('next');
    assert.equal(second.frames[0].singers[0].latePacketDrops, 1);
    assert.equal(second.frames[0].singers[1].latePacketDrops, 0);
    assert.ok(second.frames[0].singers[1].expected);
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
    assert.equal(coordinator.inspectTransport('socket-A-new'), null);
    assert.equal(coordinator.inspectTransport('socket-B')?.mediaEpoch === b.mediaEpoch, true);
  });

  test('A reconnects after old source tail fades; new media epoch fences old socket and preserves B', () => {
    const coordinator = room();
    const { a, b } = admitBoth(coordinator);
    assert.equal(coordinator.receiveFromTransport('socket-A',
      captured(FRAME, 8_000), RATE, 20), true);
    assert.equal(coordinator.receiveFromTransport('socket-B',
      captured(FRAME * 12, 6_000), RATE, 40), true);
    assert.equal(coordinator.disconnectTransport('socket-A', 80), true);
    assert.deepEqual(coordinator.admitTrusted({
      verifiedParticipantId: 'A', transportId: 'socket-A2',
      seat: 'primary', expectedPrimaryId: 'A', nowMs: 90,
    }), { ok: false, reason: 'rebind-deferred' });
    // Frame at 220 contains the old tail. The next two frames complete the
    // old source missing edge; rebind is not allowed until then.
    for (const dueMs of [220, 240, 260]) {
      const due = coordinator.renderDue(dueMs);
      assert.equal(due.state, 'ready');
    }
    const next = coordinator.admitTrusted({
      verifiedParticipantId: 'A', transportId: 'socket-A2',
      seat: 'primary', expectedPrimaryId: 'A', nowMs: 261,
    });
    assert.equal(next.ok, true);
    if (!next.ok) return;
    assert.equal(next.idempotent, false);
    assert.notEqual(next.mediaEpoch, a.mediaEpoch);
    assert.equal(coordinator.inspectTransport('socket-A'), null);
    assert.equal(coordinator.inspectTransport('socket-A2')?.mediaEpoch, next.mediaEpoch);
    assert.equal(coordinator.inspectTransport('socket-B')?.mediaEpoch, b.mediaEpoch);
    assert.equal(coordinator.snapshot().seats.primaryMicId, 'A');
    assert.equal(coordinator.snapshot().seats.songControllerId, 'A');
    assert.equal(coordinator.receiveFromTransport('socket-A',
      captured(FRAME, 9_000, FRAME), RATE, 262), false);
    assert.equal(coordinator.receiveFromTransport('socket-A2',
      captured(FRAME, 11_000), RATE, 263), true);
    const output = coordinator.renderDue(280);
    if (output.state !== 'ready') throw Error('must continue');
    assert.equal(output.frames[0].singers[0].mediaEpoch, next.mediaEpoch);
    assert.equal(output.frames[0].singers[0].awaitingCalibration, true);
    assert.equal(output.frames[0].singers[0].voicePeakAbs, 0);
    assert.equal(output.frames[0].singers[1].mediaEpoch, b.mediaEpoch);
    assert.equal(output.frames[0].singers[1].expected, true);
    const valid = {
      source: 'sample-song-estimate' as const, advanceMs: 0,
      sampleResidualMs: null, bootResidualMs: null,
      sampleCandidateMs: 0, bootCandidateMs: null,
    };
    assert.equal(coordinator.acceptTrustedReboundAlignment(
      'socket-A', next.mediaEpoch, valid, 281), false);
    assert.equal(coordinator.acceptTrustedReboundAlignment(
      'socket-A2', a.mediaEpoch, valid, 281), false);
    assert.equal(coordinator.acceptTrustedReboundAlignment(
      'socket-A2', next.mediaEpoch,
      { ...valid, source: 'content-held' }, 281), false);
    assert.equal(coordinator.acceptTrustedReboundAlignment(
      'socket-A2', next.mediaEpoch, valid, 281), true);
    const resumed = coordinator.renderDue(300);
    if (resumed.state !== 'ready') throw Error('post calibration must advance');
    assert.equal(resumed.frames[0].singers[0].awaitingCalibration, false);
    assert.equal(resumed.frames[0].singers[0].voicePeakAbs, 0,
      'fresh calibration permits reading but cannot bypass the Mic frontier cushion');
    assert.ok(resumed.frames[0].singers[0].readStartSample < RATE * 0.263,
      'this output frame is still before the new capture placement; no PCM is due yet');
    assert.equal(resumed.frames[0].singers[1].expected, true);
    // A2 was freshly captured at 263ms, hence it belongs near room sample
    // 12,624 and can only become audible when frame 12's 200ms-delayed
    // output is sealed. Prove the reconnected Mic is actually heard there.
    assert.equal(coordinator.receiveFromTransport('socket-B',
      captured(FRAME * 10, 7_000, FRAME * 12), RATE, 301), true);
    let reboundAudible = false;
    let otherAudible = false;
    for (let clock = 320; clock <= 480; clock += 20) {
      const out = coordinator.renderDue(clock);
      if (out.state !== 'ready') throw Error('monotonic room stalled');
      const aMic = out.frames[0].singers[0];
      const bMic = out.frames[0].singers[1];
      if (aMic.voicePeakAbs > 0.1) reboundAudible = true;
      if (bMic.voicePeakAbs > 0.1) otherAudible = true;
    }
    assert.equal(reboundAudible, true,
      'A2 actual captured PCM passes through canonical gain and limiter on due output');
    assert.equal(otherAudible, true, 'B canonical PCM continues across A2 rebind');
  });

  test('a calibration decision racing with a second disconnect cannot unmute the retired capture', () => {
    const coordinator = room();
    const { a, b } = admitBoth(coordinator);
    assert.equal(coordinator.receiveFromTransport('socket-A',
      captured(FRAME, 8_000), RATE, 20), true);
    assert.equal(coordinator.receiveFromTransport('socket-B',
      captured(FRAME * 12, 6_000), RATE, 40), true);
    assert.equal(coordinator.disconnectTransport('socket-A', 80), true);
    for (const at of [220, 240, 260]) {
      assert.equal(coordinator.renderDue(at).state, 'ready');
    }
    const replacement = coordinator.admitTrusted({
      verifiedParticipantId: 'A', transportId: 'socket-A2',
      seat: 'primary', expectedPrimaryId: 'A', nowMs: 261,
    });
    assert.equal(replacement.ok, true);
    if (!replacement.ok) return;
    assert.notEqual(replacement.mediaEpoch, a.mediaEpoch);
    assert.equal(coordinator.disconnectTransport('socket-A2', 270), true);
    const confirmed = {
      source: 'content' as const, advanceMs: 0,
      sampleResidualMs: null, bootResidualMs: null,
      sampleCandidateMs: null, bootCandidateMs: null,
    };
    assert.equal(coordinator.acceptTrustedReboundAlignment(
      'socket-A2', replacement.mediaEpoch, confirmed, 271), false);
    assert.equal(coordinator.acceptTrustedReboundAlignment(
      'socket-A', a.mediaEpoch, confirmed, 272), false);
    const output = coordinator.renderDue(280);
    assert.equal(output.state, 'ready');
    if (output.state !== 'ready') return;
    assert.equal(output.frames[0].singers[0].voicePeakAbs, 0);
    assert.equal(output.frames[0].singers[1].mediaEpoch, b.mediaEpoch);
    assert.equal(output.frames[0].singers[1].expected, true);
  });

  test('A to A2 to A3 rebind allocates strictly fresh media epochs and calibration authority', () => {
    const coordinator = room();
    const { a, b } = admitBoth(coordinator);
    assert.equal(coordinator.receiveFromTransport('socket-A',
      captured(FRAME, 8_000), RATE, 20), true);
    assert.equal(coordinator.receiveFromTransport('socket-B',
      captured(FRAME * 18, 6_000), RATE, 40), true);
    assert.equal(coordinator.disconnectTransport('socket-A', 80), true);
    for (const at of [220, 240, 260]) {
      assert.equal(coordinator.renderDue(at).state, 'ready');
    }
    const a2 = coordinator.admitTrusted({
      verifiedParticipantId: 'A', transportId: 'socket-A2',
      seat: 'primary', expectedPrimaryId: 'A', nowMs: 261,
    });
    assert.equal(a2.ok, true);
    if (!a2.ok) return;
    assert.ok(a2.mediaEpoch > a.mediaEpoch);
    assert.equal(coordinator.disconnectTransport('socket-A2', 270), true);
    // A2 has no audible source and cannot endow A3 with any earlier calibration.
    for (const at of [280, 300, 320]) {
      assert.equal(coordinator.renderDue(at).state, 'ready');
    }
    const a3 = coordinator.admitTrusted({
      verifiedParticipantId: 'A', transportId: 'socket-A3',
      seat: 'primary', expectedPrimaryId: 'A', nowMs: 321,
    });
    assert.equal(a3.ok, true);
    if (!a3.ok) return;
    assert.ok(a3.mediaEpoch > a2.mediaEpoch);
    assert.equal(coordinator.inspectTransport('socket-A'), null);
    assert.equal(coordinator.inspectTransport('socket-A2'), null);
    assert.equal(coordinator.inspectTransport('socket-A3')?.mediaEpoch, a3.mediaEpoch);
    assert.equal(coordinator.inspectTransport('socket-B')?.mediaEpoch, b.mediaEpoch);
    const valid = {
      source: 'content' as const, advanceMs: 0,
      sampleResidualMs: null, bootResidualMs: null,
      sampleCandidateMs: null, bootCandidateMs: null,
    };
    assert.equal(coordinator.acceptTrustedReboundAlignment(
      'socket-A2', a2.mediaEpoch, valid, 322), false);
    assert.equal(coordinator.acceptTrustedReboundAlignment(
      'socket-A3', a2.mediaEpoch, valid, 323), false);
    assert.equal(coordinator.receiveFromTransport('socket-A2',
      captured(FRAME, 12_000), RATE, 324), false);
    assert.equal(coordinator.receiveFromTransport('socket-A3',
      captured(FRAME, 12_000), RATE, 325), true);
    const stillMuted = coordinator.renderDue(340);
    assert.equal(stillMuted.state, 'ready');
    if (stillMuted.state === 'ready') {
      assert.equal(stillMuted.frames[0].singers[0].awaitingCalibration, true);
      assert.equal(stillMuted.frames[0].singers[0].voicePeakAbs, 0);
      assert.equal(stillMuted.frames[0].singers[1].mediaEpoch, b.mediaEpoch);
    }
    assert.equal(coordinator.acceptTrustedReboundAlignment(
      'socket-A3', a3.mediaEpoch, valid, 341), true);
    assert.equal(coordinator.acceptTrustedReboundAlignment(
      'socket-A3', a3.mediaEpoch, valid, 342), false);
  });

  test('expired reconnect grace cannot silently restore a revoked primary seat', () => {
    const coordinator = room();
    const { a, b } = admitBoth(coordinator);
    assert.equal(coordinator.receiveFromTransport('socket-A',
      captured(FRAME, 8_000), RATE, 20), true);
    assert.equal(coordinator.disconnectTransport('socket-A', 40), true);
    // Advance the room output clock with bounded batches (no stale playback).
    for (let clock = 220; clock <= 2_060; clock += 100) {
      assert.equal(coordinator.renderDue(clock).state, 'ready');
    }
    assert.deepEqual(coordinator.admitTrusted({
      verifiedParticipantId: 'A', transportId: 'socket-A-new',
      seat: 'primary', expectedPrimaryId: 'A', nowMs: 2_061,
    }), { ok: false, reason: 'seat-rejected' },
    'after lease expiry the old primary CAS cannot be reused');
    assert.equal(coordinator.snapshot().seats.primaryMicId, null);
    assert.equal(coordinator.snapshot().seats.songControllerId, 'A');
    assert.equal(coordinator.snapshot().seats.secondaryMicIds.includes('B'), true);
    const next = coordinator.admitTrusted({
      verifiedParticipantId: 'A', transportId: 'socket-A-new',
      seat: 'primary', expectedPrimaryId: null, nowMs: 2_062,
    });
    assert.equal(next.ok, true, 'only a new explicit seat claim may re-enter');
    if (next.ok) assert.notEqual(next.mediaEpoch, a.mediaEpoch);
    assert.equal(coordinator.inspectTransport('socket-A'), null);
    assert.equal(coordinator.inspectTransport('socket-B')?.mediaEpoch, b.mediaEpoch);
  });

  test('explicit B Take Mic requires authenticated transport and fresh CAS, no song takeover', () => {
    const coordinator = room();
    const { a, b } = admitBoth(coordinator);
    assert.equal(coordinator.receiveFromTransport('socket-A',
      captured(FRAME * 5, 6_000), RATE, 100), true);
    assert.equal(coordinator.receiveFromTransport('socket-B',
      captured(FRAME * 5, 9_000), RATE, 100), true);
    assert.equal(coordinator.takePrimaryTrusted('socket-B', null, 100), false,
      'stale CAS cannot displace A');
    assert.equal(coordinator.takePrimaryTrusted('unknown', 'A', 100), false);
    assert.equal(coordinator.takePrimaryTrusted('socket-A', 'A', 100), false,
      'primary cannot invoke secondary Take Mic');
    assert.equal(coordinator.takePrimaryTrusted('socket-B', 'A', 100), true);
    assert.equal(coordinator.snapshot().seats.primaryMicId, 'B');
    assert.equal(coordinator.snapshot().seats.songControllerId, 'A',
      'song authority remains separate from the Mic ownership');
    assert.equal(coordinator.inspectTransport('socket-A'), null);
    assert.equal(coordinator.inspectTransport('socket-A')?.mediaEpoch === a.mediaEpoch, false);
    assert.equal(coordinator.inspectTransport('socket-B')?.mediaEpoch === b.mediaEpoch, true);
    assert.equal(coordinator.inspectTransport('socket-B')?.seat, 'primary');
    assert.equal(coordinator.receiveFromTransport('socket-A',
      captured(FRAME, 16_000, FRAME * 5), RATE, 120), false);
    assert.equal(coordinator.receiveFromTransport('socket-B',
      captured(FRAME, 10_000, FRAME * 5), RATE, 120), true);
    const due = coordinator.renderDue(220);
    if (due.state !== 'ready') throw Error('not ready');
    assert.equal(due.frames[0].singers[0].expected, false);
    assert.equal(due.frames[0].singers[1].expected, true);
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
      seat: 'secondary', expectedPrimaryId: null, nowMs: 20,
    }).ok, false, 'primary must be deliberately admitted first');
    const a = coordinator.admitTrusted({
      verifiedParticipantId: 'A', transportId: 'socket-A',
      seat: 'primary', expectedPrimaryId: null, nowMs: 21,
    });
    assert.equal(a.ok, true);
    const attempted = coordinator.admitTrusted({
      verifiedParticipantId: 'B', transportId: 'socket-B',
      seat: 'primary', expectedPrimaryId: null, nowMs: 22,
    });
    assert.equal(attempted.ok, false, 'no implicit Take Mic');
    assert.equal(coordinator.snapshot().seats.primaryMicId, 'A');
  });
});
