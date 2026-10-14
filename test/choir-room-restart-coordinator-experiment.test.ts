import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SongSession } from '../src/song-session.js';
import { SourceRuntime } from '../src/source-runtime.js';
import { ChoirShadowLifecycleExperiment } from '../src/choir-shadow-lifecycle-experiment.js';
import { ChoirFreshRoomHandshakeExperiment } from '../src/choir-fresh-room-handshake-experiment.js';
import { ChoirRoomRestartCoordinatorExperiment } from '../src/choir-room-restart-coordinator-experiment.js';
import { laggedMultibandMusicPair } from './helpers/music-calibration.js';
import { ChoirSecondaryPcmIngressExperiment } from '../src/choir-secondary-pcm-ingress-experiment.js';
import { ChoirSecondaryConsentExperiment } from '../src/choir-secondary-consent-experiment.js';
import { ChoirSecondaryMediaTicketExperiment } from '../src/choir-secondary-media-ticket-experiment.js';
import { ChoirTrustedSourceMirrorExperiment } from '../src/choir-trusted-source-mirror-experiment.js';
import { ChoirLiveContentPipelineExperiment } from '../src/choir-live-content-pipeline-experiment.js';
import { encodePcmFrame } from '../src/pcm-frame.js';
import { encodeAudioPacket } from '../src/audio-packet.js';

const VIDEO = 'dQw4w9WgXcQ';
const RATE = 48_000;
const leader = { participantId: 'owner', transportId: 'playback-tab-owner', generation: 1 };
const playing = (values: Record<string, unknown> = {}) => ({
  videoId: VIDEO, state: 1, currentTime: 12, duration: 240,
  playbackRate: 1, bufferedFraction: .8, ...values,
});
type RobotSocket = { open: boolean; isRobotSource?: boolean };
function fixture(onRoomRetired: (roomEpoch: number) => void = () => {}) {
  const songs = new SongSession();
  const robot = new SourceRuntime<RobotSocket>({ isConnected: s => s.open });
  const robotSocket: RobotSocket = { open: true };
  robot.attachRobot(robotSocket);
  let backingGeneration = 9;
  let takeFrozen = false;
  let allowOwner = true;
  let rolesStillValid = true;
  const config = {
    sampleRate: RATE, frameMs: 20, prebufferMs: 400,
    retentionMs: 3_000, outputHoldbackMs: 200, contentHistoryMs: 7_000,
  };
  const shadow = new ChoirShadowLifecycleExperiment(songs, robot, config);
  const handshake = new ChoirFreshRoomHandshakeExperiment();
  const coordinator = new ChoirRoomRestartCoordinatorExperiment(
    shadow, songs, robot, () => backingGeneration,
    (approval, authority) => allowOwner
      && approval.actorParticipantId === authority.leaderParticipantId
      && approval.primaryId === 'A' && approval.secondaryId === 'B',
    () => takeFrozen, config, handshake,
    () => rolesStillValid,
    onRoomRetired,
  );
  const startSong = (at = 0) => {
    assert.equal(songs.update(playing(), leader, null, at).accepted, true);
    return (songs.statusPayload(at) as { revision: number }).revision;
  };
  const approve = (revision: number, at: number, expected = 0, actor = 'owner') =>
    coordinator.approveTrustedRestart({
      actorParticipantId: actor, primaryId: 'A', secondaryId: 'B',
      expectedPlaybackRevision: revision, expectedRetiredRoomEpoch: expected,
      nowMs: at,
    });
  const admit = (roomEpoch: number, songEpoch: number, id: string, transport: string, at: number) =>
    coordinator.admitVerifiedSinger({
      roomEpoch, songEpoch, verifiedParticipantId: id, transportId: transport,
      nowMs: at,
    });
  return {
    songs, robot, robotSocket, shadow, handshake, coordinator,
    startSong, approve, admit,
    setTakeFrozen: (v: boolean) => { takeFrozen = v; },
    setOwnerPermission: (v: boolean) => { allowOwner = v; },
    setRolesValid: (v: boolean) => { rolesStillValid = v; },
    setBacking: (v: number) => { backingGeneration = v; },
  };
}

describe('offline Choir Room Restart Coordinator uses server owned playback, robot and role authority', () => {
  test('no playback, spoofed operator, stale SongSession CAS or frozen Take can mint a room', () => {
    const f = fixture();
    assert.equal(f.coordinator.observe(0).state, 'awaiting-authority');
    assert.equal(f.approve(1, 0), false);
    const revision = f.startSong(1);
    assert.equal(f.coordinator.observe(1).state, 'awaiting-authority');
    assert.equal(f.approve(revision - 1, 1), false);
    assert.equal(f.approve(revision, 1, 0, 'intruder'), false);
    f.setOwnerPermission(false);
    assert.equal(f.approve(revision, 1), false);
    f.setOwnerPermission(true);
    f.setTakeFrozen(true);
    assert.equal(f.approve(revision, 1), false);
    f.setTakeFrozen(false);
    assert.equal(f.approve(revision, 2), true);
    assert.equal(f.approve(revision, 3), false,
      'a normal playing heartbeat cannot replay an already consumed restart approval');
    assert.deepEqual(f.coordinator.preview(), {
      state: 'awaiting-primary', roomEpoch: 1, songEpoch: 1,
      videoId: VIDEO, primaryId: 'A', secondaryId: 'B',
      primary: 'join-required', secondary: 'join-required',
      monitoring: 'backing-only',
    });
    assert.equal(f.coordinator.previewForVerifiedSinger('intruder'), null);
    assert.deepEqual(f.coordinator.previewForVerifiedSinger('B'), {
      roomEpoch: 1, songEpoch: 1, videoId: VIDEO, seat: 'secondary',
      stage: 'join-required',
    });
    assert.equal(f.admit(1, 1, 'B', 'socket-B', 4), null);
    const a = f.admit(1, 1, 'A', 'socket-A', 5);
    assert.ok(a);
    assert.equal(a?.mediaEpoch, 1);
    assert.equal(f.coordinator.preview().state, 'awaiting-secondary');
    assert.equal(f.coordinator.previewForVerifiedSinger('A')?.stage, 'calibration-required');
    const b = f.admit(1, 1, 'B', 'socket-B', 6);
    assert.ok(b);
    assert.ok(b!.mediaEpoch > a!.mediaEpoch);
    assert.equal(f.coordinator.preview().state, 'awaiting-content');
    assert.equal(f.coordinator.preview().monitoring, 'backing-only');
  });

  test('accepted Seek retires both tickets; no automatic restart and no B takeover', () => {
    const f = fixture();
    const original = f.startSong(0);
    f.coordinator.observe(0);
    assert.equal(f.coordinator.proposedRoomEpochForConsent, 1,
      'B can consent to the first proposed room before it is approved');
    assert.equal(f.approve(original, 0), true);
    const a = f.admit(1, 1, 'A', 'socket-A', 1)!;
    const b = f.admit(1, 1, 'B', 'socket-B', 2)!;
    assert.equal(f.songs.update(playing({ currentTime: 78 }), leader, null, 100).accepted, true);
    const newRevision = (f.songs.statusPayload(100) as { revision: number }).revision;
    assert.ok(newRevision > original);
    assert.equal(f.coordinator.observe(100).state, 'restart-required');
    assert.equal(f.coordinator.proposedRoomEpochForConsent, 2,
      'B can consent to NEXT Room Epoch while old room remains retired');
    assert.equal(f.coordinator.previewForVerifiedSinger('A'), null);
    assert.equal(f.coordinator.previewForVerifiedSinger('B'), null);
    assert.equal(f.coordinator.preview().monitoring, 'unavailable');
    assert.equal(f.coordinator.receiveVerifiedMic(a, {
      generation: 7, firstSampleIndex: 0,
      pcm: Buffer.from(new Int16Array(960).buffer),
    }, RATE, 101), false);
    assert.equal(f.coordinator.commitFreshContent(b, 101), false);
    assert.equal(f.admit(1, 1, 'A', 'socket-old-A', 101), null);
    assert.equal(f.approve(original, 102, 1), false,
      'stale revision cannot reopen an expired room');
    assert.equal(f.approve(newRevision, 102, 0), false,
      'old room CAS is mandatory even after fresh SongSession update');
    assert.equal(f.approve(newRevision, 102, 1), true);
    assert.equal(f.coordinator.preview().roomEpoch, 2);
    assert.equal(f.admit(2, 2, 'B', 'socket-new-B', 103), null,
      'B cannot inherit primary ownership');
    const a2 = f.admit(2, 2, 'A', 'socket-new-A', 104)!;
    const b2 = f.admit(2, 2, 'B', 'socket-new-B', 105)!;
    assert.ok(a2.mediaEpoch > b.mediaEpoch);
    assert.ok(b2.mediaEpoch > a2.mediaEpoch);
    assert.equal(a2.seat, 'primary');
    assert.equal(b2.seat, 'secondary');
    assert.equal(f.coordinator.preview().monitoring, 'backing-only',
      'the new room must independently recalibrate both Mic streams');
  });

  test('Seek between timer ticks rejects old PCM and Content even without explicit observe', () => {
    const f = fixture();
    const rev = f.startSong(0);
    f.coordinator.observe(0);
    assert.equal(f.approve(rev, 0), true);
    const a = f.admit(1, 1, 'A', 'socket-A', 1)!;
    assert.ok(a);
    assert.equal(f.coordinator.receiveVerifiedMic(a, {
      generation: 7, firstSampleIndex: 0,
      pcm: Buffer.from(new Int16Array(960).buffer),
    }, RATE, 20), true);
    // No coordinator timer call between this accepted seek and next packet.
    assert.equal(f.songs.update(playing({ currentTime: 80 }), leader, null, 100).accepted, true);
    assert.equal(f.coordinator.receiveVerifiedMic(a, {
      generation: 7, firstSampleIndex: 960,
      pcm: Buffer.from(new Int16Array(960).buffer),
    }, RATE, 101), false);
    assert.equal(f.coordinator.analyzeFreshContent(a, 0, 102).status, 'rejected');
    assert.equal(f.coordinator.commitFreshContent(a, 103), false);
    assert.equal(f.coordinator.advanceDue(1, 120), false);
    assert.equal(f.coordinator.preview().state, 'restart-required');
    assert.equal(f.coordinator.preview().monitoring, 'unavailable');
  });

  test('a frozen Take cannot promote a pending Content proof through coordinator', () => {
    const f = fixture();
    const rev = f.startSong(0);
    f.coordinator.observe(0);
    assert.equal(f.approve(rev, 0), true);
    const a = f.admit(1, 1, 'A', 'socket-A', 1)!;
    assert.ok(a);
    f.setTakeFrozen(true);
    assert.equal(f.coordinator.commitFreshContent(a, 2), false);
    f.setTakeFrozen(false);
    assert.equal(f.coordinator.commitFreshContent(a, 3), false,
      'Take was unfrozen but the actual six-second acoustic proof is absent');
    assert.equal(f.coordinator.previewForVerifiedSinger('A'), null);
    assert.equal(f.coordinator.preview().state, 'restart-required',
      'Take start retires the WHOLE room, never just holds one old proof');
  });

  test('cannot adopt another component\'s out-of-band Shadow rearm', () => {
    const f = fixture();
    const rev1 = f.startSong(0);
    f.coordinator.observe(0);
    assert.equal(f.approve(rev1, 0), true);
    assert.equal(f.songs.update(playing({ currentTime: 80 }), leader, null, 100).accepted, true);
    f.coordinator.observe(100);
    assert.equal(f.coordinator.preview().state, 'restart-required');
    // Simulate an unrelated trusted caller rearming the Shadow before this
    // coordinator issued its own explicit restart CAS.
    assert.equal(f.shadow.authorizeExplicitFreshRoom(1, 2, 2), true);
    assert.equal(f.shadow.observe(101, 9).state, 'shadow-active');
    const rev2 = (f.songs.statusPayload(101) as { revision: number }).revision;
    f.coordinator.observe(101);
    assert.equal(f.approve(rev2, 102, 1), false,
      'the new Shadow incarnation is not a substitute for our private CAS');
    assert.equal(f.coordinator.preview().monitoring, 'unavailable');
  });

  test('real coordinator binds authenticated B-only socket and fences Seek before any Mic leak', () => {
    const f = fixture();
    const revision = f.startSong(0);
    f.coordinator.observe(0);
    assert.equal(f.approve(revision, 0), true);
    const a = f.admit(1, 1, 'A', 'socket-A', 1)!;
    const b = f.admit(1, 1, 'B', 'socket-B', 2)!;
    type Socket = { participantId: string; role: string; open: boolean };
    const socket: Socket = { participantId: 'B', role: 'unknown', open: true };
    const ingress = new ChoirSecondaryPcmIngressExperiment(
      f.coordinator, s => (s as Socket).open,
    );
    const packet = encodePcmFrame(8, 0,
      Buffer.from(new Int16Array(960).fill(7_000).buffer));
    assert.equal(ingress.bindVerifiedSecondary(socket, a, RATE, 5), false,
      'original owner cannot register as B');
    assert.equal(ingress.bindVerifiedSecondary(socket, b, RATE, 6), true,
      'B is bound only to the freshly issued, real coordinator ticket');
    assert.deepEqual(ingress.interceptBinary(socket, packet, 20), {
      intercepted: true, accepted: true, reason: 'accepted',
    });
    assert.equal(f.songs.update(playing({ currentTime: 80 }), leader, null, 100).accepted,
      true);
    assert.deepEqual(ingress.interceptBinary(socket,
      encodePcmFrame(8, 960, Buffer.from(new Int16Array(960).buffer)), 101), {
      intercepted: true, accepted: false, reason: 'stale-authority',
    }, 'old B frame is consumed but cannot cross the new room epoch');
    assert.equal(f.coordinator.preview().monitoring, 'unavailable');
    assert.equal(ingress.disconnect(socket, 102), false);
    assert.equal(ingress.isAttached(socket), false);
    assert.equal(ingress.bindVerifiedSecondary(socket, b, RATE, 103), false,
      'revoked old ticket cannot bind again after the Seek');
  });

  test('real coordinator ingests phone AudioPacket v2 for B, isolates N=1 and retires it on Seek', () => {
    const f = fixture();
    const revision = f.startSong(0);
    f.coordinator.observe(0);
    assert.equal(f.approve(revision, 0), true);
    const a = f.admit(1, 1, 'A', 'socket-A', 1)!;
    const b = f.admit(1, 1, 'B', 'socket-B', 2)!;
    assert.ok(a && b);
    type Socket = { participantId: string; role: string; open: boolean };
    const socket: Socket = { participantId: 'B', role: 'unknown', open: true };
    const ingress = new ChoirSecondaryPcmIngressExperiment(
      f.coordinator, candidate => (candidate as Socket).open,
    );
    assert.equal(ingress.bindVerifiedSecondary(socket, b, RATE, 3, 2), true);
    const pcm = Buffer.from(new Int16Array(960).fill(4_000).buffer);
    const phonePacket = (sequence: number, firstSampleIndex: number) =>
      encodeAudioPacket({
        source: 'mic', generation: 8, sequence, firstSampleIndex, pcm,
      });
    assert.deepEqual(ingress.interceptBinary(socket, phonePacket(0, 0), 20), {
      intercepted: true, accepted: true, reason: 'accepted',
    });
    assert.deepEqual(ingress.interceptBinary(socket, phonePacket(0, 0), 30), {
      intercepted: true, accepted: false, reason: 'duplicate-packet',
    });
    assert.deepEqual(ingress.interceptBinary(socket, phonePacket(1, 960), 40), {
      intercepted: true, accepted: true, reason: 'accepted',
    });
    assert.equal(f.coordinator.previewForVerifiedSinger('B')?.stage,
      'calibration-required', 'PCM arrival alone never unmutes B');
    assert.equal(f.songs.update(playing({ currentTime: 90 }), leader, null, 100).accepted, true);
    assert.deepEqual(ingress.interceptBinary(socket, phonePacket(2, 1920), 101), {
      intercepted: true, accepted: false, reason: 'stale-authority',
    }, 'a fresh v2 sequence is still invalid after the song timeline moved');
    assert.equal(f.coordinator.preview().monitoring, 'unavailable');
    assert.equal(ingress.isAttached(socket), true,
      'old secondary remains quarantined until close');
    assert.equal(ingress.disconnect(socket, 102), false,
      'retired B transport cannot affect a later primary publisher');
  });

  test('continuous owner or B-consent loss retires live ticket before its next PCM frame', () => {
    for (const cause of ['owner-role-revoked', 'take-started'] as const) {
      const f = fixture();
      const revision = f.startSong(0);
      f.coordinator.observe(0);
      assert.equal(f.approve(revision, 0), true);
      const a = f.admit(1, 1, 'A', 'socket-A', 1)!;
      const b = f.admit(1, 1, 'B', 'socket-B', 2)!;
      assert.ok(a && b);
      if (cause === 'owner-role-revoked') f.setRolesValid(false);
      else f.setTakeFrozen(true);
      assert.equal(f.coordinator.receiveVerifiedMic(b, {
        generation: 8, firstSampleIndex: 0,
        pcm: Buffer.from(new Int16Array(960).buffer),
      }, RATE, 20), false);
      assert.equal(f.coordinator.preview().state, 'restart-required');
      assert.equal(f.coordinator.preview().monitoring, 'unavailable');
      assert.equal(f.coordinator.commitFreshContent(a, 21), false);
      if (cause === 'owner-role-revoked') f.setRolesValid(true);
      else f.setTakeFrozen(false);
      assert.equal(f.coordinator.receiveVerifiedMic(b, {
        generation: 8, firstSampleIndex: 960,
        pcm: Buffer.from(new Int16Array(960).buffer),
      }, RATE, 40), false,
      'restoring consent or ending Take cannot recover the retired room implicitly');
    }
  });

  test('Robot generation swap, expired leader and playback loss invalidate pending room', () => {
    for (const reason of ['robot-swap', 'backing-generation', 'leader-expired'] as const) {
      const f = fixture();
      const revision = f.startSong(0);
      f.coordinator.observe(0);
      assert.equal(f.approve(revision, 0), true);
      assert.ok(f.admit(1, 1, 'A', 'socket-A', 1));
      if (reason === 'robot-swap')
        f.robot.attachRobot({ open: true });
      if (reason === 'backing-generation') f.setBacking(10);
      const nowMs = reason === 'leader-expired' ? 2_500 : 100;
      assert.equal(f.coordinator.observe(nowMs).state, 'restart-required', reason);
      assert.equal(f.coordinator.observe(nowMs + 1).state, 'restart-required',
        'later status must not automatically open a room');
      assert.equal(f.coordinator.previewForVerifiedSinger('A'), null);
    }
  });

  test('each singer gets independent offline Content, safe monitoring readiness, and no token leak', () => {
    const f = fixture();
    const rev = f.startSong(0);
    f.coordinator.observe(0);
    assert.equal(f.approve(rev, 0), true);
    const a = f.admit(1, 1, 'A', 'socket-A', 1)!;
    const b = f.admit(1, 1, 'B', 'socket-B', 2)!;
    const { mic, backing } = laggedMultibandMusicPair(6, RATE, 120, { singerGain: .18 });
    const chunk = 2 * RATE;
    for (let at = 20; at <= 6_000; at += 20) {
      // The real SongSession requires accepted fresh PLAYING telemetry;
      // a six-second test without heartbeats must fail closed.
      if (at % 1_000 === 0)
        assert.equal(f.songs.update(
          playing({ currentTime: 12 + at / 1_000 }), leader, null, at,
        ).accepted, true);
      if (at % 2_000 === 0) {
        const first = (at / 2_000 - 1) * chunk;
        const end = first + chunk;
        for (const [ticket, generation] of [[a, 7], [b, 8]] as const) {
          assert.equal(f.coordinator.receiveVerifiedMic(ticket, {
            generation, firstSampleIndex: first,
            pcm: mic.subarray(first * 2, end * 2),
          }, RATE, at), true);
        }
        assert.equal(f.coordinator.receiveTrustedRobot(1, 1, {
          generation: 9, firstSampleIndex: first,
          pcm: backing.subarray(first * 2, end * 2),
        }, RATE, at), true);
      }
      assert.equal(f.coordinator.advanceDue(1, at), true);
      f.coordinator.observe(at);
    }
    assert.equal(f.coordinator.analyzeFreshContent(a, 0, 6_001).status, 'candidate');
    assert.equal(f.coordinator.analyzeFreshContent(b, 0, 6_002).status, 'candidate');
    assert.equal(f.coordinator.commitFreshContent(a, 6_003), true);
    assert.equal(f.coordinator.preview().state, 'partially-ready');
    assert.equal(f.coordinator.preview().monitoring, 'one-voice');
    assert.equal(f.coordinator.previewForVerifiedSinger('A')?.stage, 'ready');
    assert.equal(f.coordinator.previewForVerifiedSinger('B')?.stage, 'calibration-required');
    assert.equal(f.coordinator.commitFreshContent(b, 6_004), true);
    assert.equal(f.coordinator.preview().state, 'duet-ready');
    assert.equal(f.coordinator.preview().monitoring, 'two-voices');
    const notice = f.coordinator.previewForVerifiedSinger('A');
    assert.ok(notice);
    assert.equal('transportId' in notice, false);
    assert.equal('mediaEpoch' in notice, false);
    assert.equal('PCM' in notice, false);
  });
  test('verified existing N=1 A and Robot PCM mirror into bounded live canonical Content proof', () => {
    const f = fixture();
    const revision = f.startSong(0);
    f.coordinator.observe(0);
    assert.equal(f.approve(revision, 0), true);
    const a = f.admit(1, 1, 'A', 'existing-n1-primary', 1)!;
    const b = f.admit(1, 1, 'B', 'secondary-native-v2', 2)!;
    const primarySocket = { id: 'authenticated-n1-a' };
    const robotBackingSocket = { id: 'registered-robot-backing' };
    const source = {
      primarySocket, primaryOwnerId: 'A', primaryGeneration: 7,
      primaryRate: RATE, robotBackingSocket, robotBackingGeneration: 9,
      robotControlGeneration: f.robot.generation, robotRate: RATE,
      robotIsAuthoritative: true,
    };
    const mirror = new ChoirTrustedSourceMirrorExperiment(f.coordinator,
      () => source);
    assert.equal(mirror.bindPrimary(a, 3), true);
    assert.equal(mirror.bindPrimary(a, 4), false, 'never silently rebind one Room Epoch');
    assert.equal(mirror.mirrorPrimary({ generation: 7, firstSampleIndex: 0,
      pcm: Buffer.alloc(960 * 2) }, false, 5), false,
      'partially accepted PCM cannot enter Choir history');
    assert.equal(mirror.roomEpoch, 1, 'a rejected packet alone does not retire the room');
    const { mic, backing } = laggedMultibandMusicPair(
      6, RATE, 120, { singerGain: .18 },
    );
    const chunk = 2 * RATE;
    for (let at = 20; at <= 6_000; at += 20) {
      if (at % 1_000 === 0)
        assert.equal(f.songs.update(
          playing({ currentTime: 12 + at / 1_000 }), leader, null, at,
        ).accepted, true);
      if (at % 2_000 === 0) {
        const first = (at / 2_000 - 1) * chunk;
        const end = first + chunk;
        const frame = { generation: 7, firstSampleIndex: first,
          pcm: mic.subarray(first * 2, end * 2) };
        assert.equal(mirror.mirrorPrimary(frame, true, at), true);
        assert.equal(mirror.mirrorRobot({
          generation: 9, firstSampleIndex: first,
          pcm: backing.subarray(first * 2, end * 2),
        }, true, at), true);
        assert.equal(f.coordinator.receiveVerifiedMic(b, {
          generation: 8, firstSampleIndex: first,
          pcm: mic.subarray(first * 2, end * 2),
        }, RATE, at), true);
      }
      assert.equal(f.coordinator.advanceDue(1, at), true);
    }
    const analysisA = f.coordinator.analyzeFreshContent(a, 0, 6_001);
    const analysisB = f.coordinator.analyzeFreshContent(b, 0, 6_002);
    assert.equal(analysisA.status, 'candidate');
    assert.equal(analysisB.status, 'candidate');
    assert.equal(f.coordinator.commitFreshContent(a, 6_003), true);
    assert.equal(f.coordinator.commitFreshContent(b, 6_004), true);
    assert.equal(f.coordinator.preview().state, 'duet-ready',
      'readiness refers to proof-only canonical room, NOT N=1 monitoring');
  });


  test('Seek synchronously releases old mirror without waiting for a PCM packet', () => {
    let mirror: ChoirTrustedSourceMirrorExperiment | null = null;
    const f = fixture((roomEpoch) => { mirror?.revokeRoom(roomEpoch); });
    const revision = f.startSong(0);
    f.coordinator.observe(0);
    assert.equal(f.approve(revision, 0), true);
    const a1 = f.admit(1, 1, 'A', 'primary-1', 1)!;
    const primarySocket = { id: 'authenticated-a' };
    const robotBackingSocket = { id: 'robot-backing' };
    const state = {
      primarySocket, primaryOwnerId: 'A', primaryGeneration: 7,
      primaryRate: RATE, robotBackingSocket, robotBackingGeneration: 9,
      robotControlGeneration: f.robot.generation, robotRate: RATE,
      robotIsAuthoritative: true,
    };
    mirror = new ChoirTrustedSourceMirrorExperiment(f.coordinator, () => state);
    assert.equal(mirror.bindPrimary(a1, 2), true);
    assert.equal(mirror.roomEpoch, 1);

    // SongSession invalidates the room. No Mic or Robot frame is delivered
    // between retirement and the new Room Epoch's primary admission.
    assert.equal(f.songs.update(playing({ currentTime: 81 }), leader, null, 100).accepted, true);
    const nextRevision = (f.songs.statusPayload(100) as { revision: number }).revision;
    assert.equal(f.coordinator.observe(100).state, 'restart-required');
    assert.equal(mirror.roomEpoch, null, 'no stale source binding remains after Seek');
    assert.equal(f.approve(nextRevision, 101, 1), true);
    const a2 = f.admit(2, 2, 'A', 'primary-2', 102)!;
    assert.equal(mirror.bindPrimary(a2, 103), true,
      'new authority binds immediately, without an old PCM clean-up packet');
    assert.equal(mirror.roomEpoch, 2);
    assert.equal(mirror.revokeRoom(1), false,
      'late old-room revocation cannot clear the newly authorized mirror');
    assert.equal(mirror.roomEpoch, 2);
  });


  test('real Worker asynchronously aligns A and B from trusted server-side 6s PCM', {
    timeout: 30_000,
  }, async () => {
    const f = fixture();
    const rev = f.startSong(0);
    f.coordinator.observe(0);
    assert.equal(f.approve(rev, 0), true);
    const a = f.admit(1, 1, 'A', 'primary-A', 1)!;
    const b = f.admit(1, 1, 'B', 'secondary-B', 2)!;
    const primarySocket = { id: 'existing-n1-a' };
    const robotBackingSocket = { id: 'robot-backed-source' };
    const current = {
      primarySocket, primaryOwnerId: 'A', primaryGeneration: 7,
      primaryRate: RATE, robotBackingSocket, robotBackingGeneration: 9,
      robotControlGeneration: f.robot.generation, robotRate: RATE,
      robotIsAuthoritative: true,
    };
    const mirror = new ChoirTrustedSourceMirrorExperiment(f.coordinator, () => current);
    assert.equal(mirror.bindPrimary(a, 3), true);
    const { mic, backing } = laggedMultibandMusicPair(6, RATE, 120, { singerGain: .18 });
    const chunk = 2 * RATE;
    for (let at = 20; at <= 6_000; at += 20) {
      if (at % 1_000 === 0) {
        assert.equal(f.songs.update(
          playing({ currentTime: 12 + at / 1_000 }), leader, null, at,
        ).accepted, true);
      }
      if (at % 2_000 === 0) {
        const first = (at / 2_000 - 1) * chunk;
        const end = first + chunk;
        assert.equal(mirror.mirrorPrimary({
          generation: 7, firstSampleIndex: first,
          pcm: mic.subarray(first * 2, end * 2),
        }, true, at), true);
        assert.equal(mirror.mirrorRobot({
          generation: 9, firstSampleIndex: first,
          pcm: backing.subarray(first * 2, end * 2),
        }, true, at), true);
        assert.equal(f.coordinator.receiveVerifiedMic(b, {
          generation: 8, firstSampleIndex: first,
          pcm: mic.subarray(first * 2, end * 2),
        }, RATE, at), true);
      }
      assert.equal(f.coordinator.advanceDue(1, at), true);
    }

    let approvedClock = 6_020;
    const pipeline = new ChoirLiveContentPipelineExperiment(f.coordinator, {
      now: () => approvedClock, workTimeoutMs: 2_400, retryDelayMs: 250,
    });
    const until = async (condition: () => boolean, reason: string) => {
      const deadline = Date.now() + 9_000;
      while (!condition() && Date.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 30));
      assert.ok(condition(), reason);
    };
    try {
      assert.equal(pipeline.tick(6_001), true,
        'A is eligible from real source-mirrored PCM, without direct analyzer invocation');
      await until(() => !pipeline.isBusy, 'A worker must settle');
      assert.equal(pipeline.stats.applied, 1, 'A result commits only through coordinator');
      assert.equal(f.coordinator.preview().state, 'partially-ready');
      // The real server drains the room every 5ms. Do not fake a 340ms
      // scheduler stall between A and B's worker jobs: that must fail closed.
      for (let at = 6_020; at <= 6_340; at += 20)
        assert.equal(f.coordinator.advanceDue(1, at), true);
      approvedClock = 6_350;
      assert.equal(pipeline.tick(6_340), true, 'B uses its own independent ticket and capture');
      await until(() => !pipeline.isBusy, 'B worker must settle');
      assert.equal(pipeline.stats.applied, 2);
      assert.equal(f.coordinator.preview().state, 'duet-ready');
      assert.equal(f.coordinator.preview().monitoring, 'two-voices',
        'proof-only readiness is not a deployed duet monitor');
    } finally {
      pipeline.close();
    }
  });


  test('Seek cancels a running Content Worker and fences late Room Epoch proof', () => {
    const f = fixture();
    const rev = f.startSong(0);
    f.coordinator.observe(0);
    assert.equal(f.approve(rev, 0), true);
    const a = f.admit(1, 1, 'A', 'primary-A', 1)!;
    const pcm = Buffer.alloc(2 * RATE * 2, 13);
    for (let at = 20; at <= 6_000; at += 20) {
      if (at % 1_000 === 0) {
        assert.equal(f.songs.update(
          playing({ currentTime: 12 + at / 1_000 }), leader, null, at,
        ).accepted, true);
      }
      if (at % 2_000 === 0) {
        const first = (at / 2_000 - 1) * RATE * 2;
        assert.equal(f.coordinator.receiveVerifiedMic(a, {
          generation: 7, firstSampleIndex: first, pcm,
        }, RATE, at), true);
        assert.equal(f.coordinator.receiveTrustedRobot(1, 1, {
          generation: 9, firstSampleIndex: first, pcm,
        }, RATE, at), true);
      }
      assert.equal(f.coordinator.advanceDue(1, at), true);
    }
    const stale = f.coordinator.prepareFreshWorkerContent(6_001);
    assert.ok(stale, 'exact six-second positioned room history is complete');
    const pipeline = new ChoirLiveContentPipelineExperiment(f.coordinator, {
      now: () => 6_003, retryDelayMs: 250,
    });
    try {
      assert.equal(pipeline.tick(6_001), true);
      assert.equal(pipeline.isBusy, true);
      assert.equal(f.songs.update(
        playing({ currentTime: 88 }), leader, null, 6_002,
      ).accepted, true);
      assert.equal(f.coordinator.observe(6_002).state, 'restart-required');
      pipeline.cancelRoom(1);
      assert.equal(pipeline.isBusy, false);
      assert.equal(pipeline.stats.applied, 0);
      assert.equal(f.coordinator.acceptFreshWorkerContent(
        stale.ticket, stale.proof, { micLagMs: 120, confidence: .9 }, 6_003,
      ), false, 'old six-second worker proof cannot cross a Seek');
      assert.equal(f.coordinator.preview().monitoring, 'unavailable');
    } finally {
      pipeline.close();
    }
  });

  test('A capture replacement, Robot control replacement and invalid native generation retire old mirror', () => {
    for (const change of ['primary-socket', 'primary-generation',
      'robot-backing-socket', 'robot-control-generation',
      'robot-native-generation'] as const) {
      const f = fixture();
      const rev = f.startSong(0);
      f.coordinator.observe(0);
      assert.equal(f.approve(rev, 0), true);
      const a = f.admit(1, 1, 'A', 'trusted-A', 1)!;
      const primarySocket = { id: 'primary' };
      const robotBackingSocket = { id: 'backing' };
      const state = {
        primarySocket, primaryOwnerId: 'A', primaryGeneration: 7,
        primaryRate: RATE, robotBackingSocket, robotBackingGeneration: 9,
        robotControlGeneration: f.robot.generation, robotRate: RATE,
        robotIsAuthoritative: true,
      };
      const mirror = new ChoirTrustedSourceMirrorExperiment(
        f.coordinator, () => state,
      );
      assert.equal(mirror.bindPrimary(a, 2), true);
      if (change === 'primary-socket') state.primarySocket = { id: 'other-primary' };
      if (change === 'primary-generation') state.primaryGeneration = 8;
      if (change === 'robot-backing-socket')
        state.robotBackingSocket = { id: 'other-robot' };
      if (change === 'robot-control-generation') state.robotControlGeneration = 88;
      if (change === 'robot-native-generation') state.robotBackingGeneration = 10;
      assert.equal(mirror.mirrorPrimary({
        generation: 7, firstSampleIndex: 0,
        pcm: Buffer.from(new Int16Array(960).buffer),
      }, true, 20), false);
      assert.equal(mirror.roomEpoch, null);
      assert.equal(f.coordinator.preview().state, 'restart-required', change);
      assert.equal(f.coordinator.receiveVerifiedMic(a, {
        generation: 7, firstSampleIndex: 960,
        pcm: Buffer.from(new Int16Array(960).buffer),
      }, RATE, 21), false);
    }
  });

  test('one-time consenting B media grant binds only a distinct authenticated socket after A admission', () => {
    const f = fixture();
    const rev = f.startSong(0);
    f.coordinator.observe(0);
    assert.equal(f.approve(rev, 0), true);
    type Socket = { participantId: string; role: string; open: boolean };
    const aControl: Socket = { participantId: 'A', role: 'unknown', open: true };
    const bControl: Socket = { participantId: 'B', role: 'unknown', open: true };
    const bOtherTab: Socket = { participantId: 'B', role: 'unknown', open: true };
    const bMedia: Socket = { participantId: 'B', role: 'unknown', open: true };
    const cMedia: Socket = { participantId: 'C', role: 'unknown', open: true };
    const consent = new ChoirSecondaryConsentExperiment({
      scopeNow: () => ({
        roomEpoch: 1, playbackRevision: rev, videoId: VIDEO,
        backingGeneration: 9, robotSourceGeneration: f.robot.generation,
      }),
      primaryStillOwnsMic: id => id === 'A' && aControl.open,
      participantConnected: id => id === 'B' && bControl.open,
      takeFrozenNow: () => false,
      socketOpen: socket => (socket as Socket).open,
      notifyParticipant: () => {},
      notifySocket: () => {},
    });
    const ingress = new ChoirSecondaryPcmIngressExperiment(f.coordinator,
      socket => (socket as Socket).open);
    const broker = new ChoirSecondaryMediaTicketExperiment(
      f.coordinator, consent, ingress, socket => (socket as Socket).open, 1_000,
    );
    const id = consent.invite(aControl, 'B', 1)!;
    assert.equal(consent.respond(bControl, id, true, 2), true);
    assert.equal(broker.issue(bOtherTab, 3), null,
      'another authenticated B tab is not the consenting socket');
    assert.equal(broker.issue(bControl, 3), null,
      'B consent alone must not reserve Media Epoch before A admission');
    const a = f.admit(1, 1, 'A', 'socket-A', 4)!;
    assert.ok(a && a.seat === 'primary');
    const first = broker.issue(bControl, 5)!;
    assert.match(first.claimToken, /^[0-9a-f]{64}$/);
    assert.equal(f.coordinator.preview().secondary, 'join-required',
      'issuing an opaque claim never consumes B Media Epoch');
    assert.equal(broker.redeem(cMedia, first.claimToken, RATE, 2, 6), null,
      'a claim stolen by an unrelated participant is burned');
    assert.equal(broker.redeem(bMedia, first.claimToken, RATE, 2, 7), null);
    const old = broker.issue(bControl, 8)!;
    const latest = broker.issue(bControl, 9)!;
    assert.notEqual(old.claimToken, latest.claimToken);
    assert.equal(broker.pendingCount, 1);
    assert.equal(broker.redeem(bMedia, old.claimToken, RATE, 2, 10), null,
      'superseded token cannot be replayed');
    const b = broker.redeem(bMedia, latest.claimToken, RATE, 2, 11)!;
    assert.ok(b);
    assert.equal(b.participantId, 'B');
    assert.equal(b.seat, 'secondary');
    assert.ok(b.mediaEpoch > a.mediaEpoch);
    assert.equal(broker.pendingCount, 0);
    assert.equal(ingress.isAttached(bMedia), true);
    assert.equal(broker.redeem(bMedia, latest.claimToken, RATE, 2, 12), null);
    assert.equal(f.coordinator.preview().monitoring, 'backing-only',
      'a verified secondary PCM channel MUST wait for individual Content proof');

    const pcm = Buffer.from(new Int16Array(960).fill(2_000).buffer);
    const packet = encodeAudioPacket({
      source: 'mic', generation: 7, firstSampleIndex: 0, sequence: 0, pcm,
    });
    assert.deepEqual(ingress.interceptBinary(bMedia, packet, 20), {
      intercepted: true, accepted: true, reason: 'accepted',
    });
    assert.equal(f.coordinator.preview().secondary, 'calibration-required');
    assert.equal(f.coordinator.preview().monitoring, 'backing-only');
    assert.equal(f.songs.update(playing({ currentTime: 80 }), leader, null, 100).accepted, true);
    assert.deepEqual(ingress.interceptBinary(bMedia,
      encodeAudioPacket({
        source: 'mic', generation: 7, firstSampleIndex: 960, sequence: 1, pcm,
      }), 101), { intercepted: true, accepted: false, reason: 'stale-authority' });
  });

  test('media grants expire, revoke and cannot become a Mic Epoch if Take or consent ends', () => {
    const f = fixture();
    const rev = f.startSong(0);
    f.coordinator.observe(0);
    assert.equal(f.approve(rev, 0), true);
    assert.ok(f.admit(1, 1, 'A', 'socket-A', 1));
    type Socket = { participantId: string; role: string; open: boolean };
    const a: Socket = { participantId: 'A', role: 'unknown', open: true };
    const b: Socket = { participantId: 'B', role: 'unknown', open: true };
    const media: Socket = { participantId: 'B', role: 'unknown', open: true };
    const consent = new ChoirSecondaryConsentExperiment({
      scopeNow: () => ({
        roomEpoch: 1, playbackRevision: rev, videoId: VIDEO,
        backingGeneration: 9, robotSourceGeneration: f.robot.generation,
      }),
      primaryStillOwnsMic: id => id === 'A' && a.open,
      participantConnected: id => id === 'B' && b.open,
      takeFrozenNow: () => false,
      socketOpen: socket => (socket as Socket).open,
      notifyParticipant: () => {}, notifySocket: () => {},
    });
    const ingress = new ChoirSecondaryPcmIngressExperiment(f.coordinator,
      socket => (socket as Socket).open);
    const broker = new ChoirSecondaryMediaTicketExperiment(
      f.coordinator, consent, ingress, socket => (socket as Socket).open, 1_000);
    const invite = consent.invite(a, 'B', 2)!;
    assert.equal(consent.respond(b, invite, true, 3), true);
    const expiry = broker.issue(b, 4)!;
    assert.equal(broker.redeem(media, expiry.claimToken, RATE, 2, 1_005), null);
    assert.equal(f.coordinator.preview().secondary, 'join-required');
    const revoked = broker.issue(b, 1_006)!;
    assert.equal(consent.withdraw(b, 1_007), true);
    assert.equal(broker.redeem(media, revoked.claimToken, RATE, 2, 1_008), null);
    assert.equal(broker.pendingCount, 0);
    assert.equal(f.coordinator.preview().secondary, 'join-required');
  });

  test('failed physical B media bind retires the room and cannot replay a half-admitted seat', () => {
    const f = fixture();
    const rev = f.startSong(0);
    f.coordinator.observe(0);
    assert.equal(f.approve(rev, 0), true);
    assert.ok(f.admit(1, 1, 'A', 'socket-A', 1));
    type Socket = { participantId: string; role: string; open: boolean };
    const a: Socket = { participantId: 'A', role: 'unknown', open: true };
    const b: Socket = { participantId: 'B', role: 'unknown', open: true };
    const media: Socket = { participantId: 'B', role: 'unknown', open: true };
    const consent = new ChoirSecondaryConsentExperiment({
      scopeNow: () => ({ roomEpoch: 1, playbackRevision: rev, videoId: VIDEO,
        backingGeneration: 9, robotSourceGeneration: f.robot.generation }),
      primaryStillOwnsMic: id => id === 'A',
      participantConnected: id => id === 'B',
      takeFrozenNow: () => false,
      socketOpen: socket => (socket as Socket).open,
      notifyParticipant: () => {}, notifySocket: () => {},
    });
    const invite = consent.invite(a, 'B', 2)!;
    assert.equal(consent.respond(b, invite, true, 3), true);
    const broker = new ChoirSecondaryMediaTicketExperiment(
      f.coordinator, consent, { bindVerifiedSecondary: () => false },
      socket => (socket as Socket).open,
    );
    const grant = broker.issue(b, 4)!;
    assert.equal(broker.redeem(media, grant.claimToken, RATE, 2, 5), null);
    assert.equal(f.coordinator.preview().state, 'restart-required',
      'a bound-seat failure is fatal for the old Room Epoch');
    assert.equal(f.coordinator.preview().monitoring, 'unavailable');
    assert.equal(f.coordinator.proposedRoomEpochForConsent, 2);
    assert.equal(broker.redeem(media, grant.claimToken, RATE, 2, 6), null);
    assert.equal(broker.issue(b, 7), null,
      'even freshly minted claims may not re-use a retired room or old consent');
    assert.equal(f.admit(1, 1, 'B', 'another-B', 8), null,
      'old room cannot hand the secondary seat to another transport');
    assert.equal(f.coordinator.receiveVerifiedMic({
      roomEpoch: 1, songEpoch: 1, participantId: 'B',
      seat: 'secondary', transportId: 'another-B', mediaEpoch: 2,
    }, {
      generation: 7, firstSampleIndex: 0,
      pcm: Buffer.from(new Int16Array(960).buffer),
    }, RATE, 9), false);
  });

});
