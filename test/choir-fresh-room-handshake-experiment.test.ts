import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ChoirFreshRoomHandshakeExperiment, type FreshChoirRoomSpec } from '../src/choir-fresh-room-handshake-experiment.js';
import { laggedMultibandMusicPair } from './helpers/music-calibration.js';

const RATE = 48_000;
const FRAME = 960;
const VIDEO = 'abcdefghijk';
const fresh = () => new ChoirFreshRoomHandshakeExperiment();
const spec = (roomEpoch: number, overrides: Partial<FreshChoirRoomSpec> = {}): FreshChoirRoomSpec => ({
  sampleRate: RATE, frameMs: 20, prebufferMs: 400,
  retentionMs: 3_000, contentHistoryMs: 7_000,
  roomEpoch, songEpoch: roomEpoch + 6,
  backingGeneration: 9, roomEpochMs: 0,
  outputHoldbackMs: 200, mappingEpoch: roomEpoch,
  videoId: VIDEO, primaryId: 'A', secondaryId: 'B',
  ...overrides,
});
const pcm = (samples: number, value = 6_000, generation = 7, firstSampleIndex = 0) => ({
  generation, firstSampleIndex,
  pcm: Buffer.from(new Int16Array(samples).fill(value).buffer),
});
const admit = (
  flow: ChoirFreshRoomHandshakeExperiment,
  roomEpoch: number, id: string, transportId: string, at = 1,
) => flow.admitVerifiedSinger({
  roomEpoch, songEpoch: roomEpoch + 6,
  verifiedParticipantId: id, transportId, nowMs: at,
});

describe('Choir fresh room two-singer handshake', () => {
  test('requires primary before secondary; identity and seat cannot be client-promoted', () => {
    const flow = fresh();
    assert.equal(flow.beginTrustedRoom(spec(1)), true);
    assert.equal(admit(flow, 1, 'B', 'socket-B'), null,
      'a secondary has no authority to create or inherit a primary');
    assert.equal(admit(flow, 1, 'intruder', 'socket-X'), null);
    assert.equal(admit(flow, 2, 'A', 'socket-A'), null);
    const a = admit(flow, 1, 'A', 'socket-A');
    assert.ok(a);
    assert.equal(a?.seat, 'primary');
    assert.equal(admit(flow, 1, 'A', 'socket-A2'), null,
      'a duplicated admission cannot silently replace a live Capture');
    assert.equal(flow.snapshot().state, 'awaiting-secondary');
    const b = admit(flow, 1, 'B', 'socket-B', 2);
    assert.ok(b);
    assert.equal(b?.seat, 'secondary');
    assert.notEqual(b?.mediaEpoch, a?.mediaEpoch);
    assert.equal(flow.snapshot().state, 'awaiting-content');
    assert.deepEqual(flow.snapshot().contentVerifiedIds, []);
    assert.equal(flow.beginTrustedRoom(spec(2)), false,
      'a new room cannot be minted while the old room is still active');
  });

  test('explicit new room fences all old tickets and allocates globally increasing Media Epochs', () => {
    const flow = fresh();
    assert.equal(flow.beginTrustedRoom(spec(1)), true);
    const a = admit(flow, 1, 'A', 'socket-A')!;
    const b = admit(flow, 1, 'B', 'socket-B', 2)!;
    assert.equal(flow.receiveVerifiedMic(a, pcm(FRAME), RATE, 3), true);
    assert.equal(flow.receiveVerifiedMic(b, pcm(FRAME, 5_000, 8), RATE, 4), true);
    assert.equal(flow.retireTrustedRoom(1, 5), true);
    assert.equal(flow.snapshot().state, 'retired');
    assert.equal(flow.retireTrustedRoom(1, 6), false);
    assert.equal(flow.beginTrustedRoom(spec(1)), false);
    assert.equal(flow.beginTrustedRoom(spec(2, { songEpoch: 7 })), false,
      'a room restart cannot reuse a previous Song Epoch');
    assert.equal(flow.beginTrustedRoom(spec(2)), true);
    assert.equal(flow.receiveVerifiedMic(a, pcm(FRAME), RATE, 6), false);
    assert.equal(flow.receiveVerifiedMic(b, pcm(FRAME), RATE, 6), false);
    assert.equal(flow.analyzeFreshContent(a, 0, 6).status, 'rejected');
    assert.equal(flow.commitFreshContent(a, 6, false), false);
    assert.equal(admit(flow, 1, 'B', 'socket-B2'), null);
    assert.equal(admit(flow, 2, 'B', 'socket-B2'), null);
    const a2 = admit(flow, 2, 'A', 'socket-A2', 7)!;
    const b2 = admit(flow, 2, 'B', 'socket-B2', 8)!;
    assert.ok(a2.mediaEpoch > b.mediaEpoch);
    assert.ok(b2.mediaEpoch > a2.mediaEpoch);
    assert.ok(a2.roomEpoch > a.roomEpoch);
    assert.equal(flow.receiveVerifiedMic(a, pcm(FRAME), RATE, 9), false);
    assert.equal(flow.receiveVerifiedMic(a2, pcm(FRAME, 9_000, 10), RATE, 9), true);
    assert.deepEqual(flow.snapshot().admittedIds, ['A', 'B']);
    assert.deepEqual(flow.snapshot().contentVerifiedIds, [],
      'no old Content/Boot/Sample authority carries into a new Choir room');
  });

  test('primary disconnect leaves B secondary; no automatic reassignment or old capture resumption', () => {
    const flow = fresh();
    assert.equal(flow.beginTrustedRoom(spec(1)), true);
    const a = admit(flow, 1, 'A', 'socket-A')!;
    const b = admit(flow, 1, 'B', 'socket-B', 2)!;
    assert.equal(flow.disconnectVerifiedSinger(a, 3), true);
    assert.equal(flow.disconnectVerifiedSinger(a, 4), false);
    assert.equal(flow.receiveVerifiedMic(a, pcm(FRAME), RATE, 5), false);
    assert.equal(flow.receiveVerifiedMic(b, pcm(FRAME), RATE, 5), true,
      'B remains a separate authorized secondary capture');
    assert.equal(flow.snapshot().primaryId, 'A');
    assert.equal(flow.snapshot().secondaryId, 'B');
    assert.deepEqual(flow.snapshot().admittedIds, ['B']);
    assert.equal(admit(flow, 1, 'B', 'socket-B2'), null,
      'B cannot claim a new primary by duplicating its transport');
    assert.equal(flow.beginTrustedRoom(spec(2)), false);
    assert.equal(flow.retireTrustedRoom(1, 6), true);
    assert.equal(flow.beginTrustedRoom(spec(2)), true);
    assert.equal(admit(flow, 2, 'B', 'socket-B3'), null,
      'even in the new room B must not become primary automatically');
  });

  test('Content is proven independently for both new captures from real six-second room PCM', () => {
    const flow = fresh();
    assert.equal(flow.beginTrustedRoom(spec(1)), true);
    const a = admit(flow, 1, 'A', 'socket-A')!;
    const b = admit(flow, 1, 'B', 'socket-B', 2)!;
    assert.equal(flow.commitFreshContent(a, 5, false), false);
    assert.equal(flow.commitFreshContent(b, 5, false), false);
    assert.equal(flow.analyzeFreshContent(a, 0, 6).status, 'rejected');
    const { mic, backing } = laggedMultibandMusicPair(8, RATE, 120, {
      singerGain: 0.18,
    });
    const chunk = 2 * RATE;
    for (let at = 20; at <= 6_000; at += 20) {
      if (at % 2_000 === 0) {
        const first = (at / 2_000 - 1) * chunk;
        const end = first + chunk;
        const micFrame = {
          generation: 7, firstSampleIndex: first,
          pcm: mic.subarray(first * 2, end * 2),
        };
        const micFrameB = {
          generation: 8, firstSampleIndex: first,
          pcm: mic.subarray(first * 2, end * 2),
        };
        const robotFrame = {
          generation: 9, firstSampleIndex: first,
          pcm: backing.subarray(first * 2, end * 2),
        };
        assert.equal(flow.receiveVerifiedMic(a, micFrame, RATE, at), true);
        assert.equal(flow.receiveVerifiedMic(b, micFrameB, RATE, at), true);
        assert.equal(flow.receiveTrustedRobot(1, 7, robotFrame, RATE, at), true);
      }
      assert.equal(flow.advanceDue(1, at), true);
      if (at >= 2_000) {
        const evidence = flow.lastSingerEvidence();
        assert.equal(evidence.length, 2);
        for (const singer of evidence) {
          assert.equal(singer.awaitingCalibration, true,
            'initial Mic capture is muted despite receiving actual PCM');
          assert.equal(singer.voicePeakAbs, 0,
            'no singer is allowed to bypass first-room Content proof');
        }
      }
    }
    const aProof = flow.analyzeFreshContent(a, 0, 6_001);
    const bProof = flow.analyzeFreshContent(b, 0, 6_002);
    assert.equal(aProof.status, 'candidate', JSON.stringify(aProof));
    assert.equal(bProof.status, 'candidate', JSON.stringify(bProof));
    assert.equal(flow.commitFreshContent(a, 6_003, true), false,
      'Take freeze prevents new vocal authority even with measured Content');
    assert.equal(flow.commitFreshContent(a, 6_004, false), true);
    assert.deepEqual(flow.snapshot().contentVerifiedIds, ['A']);
    assert.equal(flow.commitFreshContent(a, 6_005, false), false,
      'a proof may be consumed only once');
    assert.equal(flow.commitFreshContent(b, 6_006, false), true);
    assert.deepEqual(flow.snapshot().contentVerifiedIds, ['A', 'B']);
    // Extend the SAME native Mic generations and Robot generation with
    // continuous future PCM. This proves that successful Content authorization
    // actually permits audible output once the canonical frontier is present.
    const first = 6 * RATE;
    const end = 8 * RATE;
    assert.equal(flow.receiveVerifiedMic(a, {
      generation: 7, firstSampleIndex: first,
      pcm: mic.subarray(first * 2, end * 2),
    }, RATE, 6_007), true);
    assert.equal(flow.receiveVerifiedMic(b, {
      generation: 8, firstSampleIndex: first,
      pcm: mic.subarray(first * 2, end * 2),
    }, RATE, 6_008), true);
    assert.equal(flow.receiveTrustedRobot(1, 7, {
      generation: 9, firstSampleIndex: first,
      pcm: backing.subarray(first * 2, end * 2),
    }, RATE, 6_009), true);
    let audibleA = false;
    let audibleB = false;
    for (let at = 6_020; at <= 6_420; at += 20) {
      assert.equal(flow.advanceDue(1, at), true);
      for (const singer of flow.lastSingerEvidence()) {
        assert.equal(singer.awaitingCalibration, false);
        if (singer.participantId === 'A' && singer.voicePeakAbs > .01) audibleA = true;
        if (singer.participantId === 'B' && singer.voicePeakAbs > .01) audibleB = true;
      }
    }
    assert.equal(audibleA, true, 'new A really passes the PCM output edge');
    assert.equal(audibleB, true, 'new B really passes the PCM output edge');
    assert.equal(flow.retireTrustedRoom(1, 6_421), true);
    assert.deepEqual(flow.snapshot().contentVerifiedIds, []);
    assert.equal(flow.commitFreshContent(b, 6_422, false), false);
  });
});
