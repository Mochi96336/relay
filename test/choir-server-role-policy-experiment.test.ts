import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ParticipantSession } from '../src/participant-session.js';
import { authorizeChoirRestartWithLiveRoles } from '../src/choir-server-role-policy-experiment.js';
import type { ChoirRestartApproval } from '../src/choir-room-restart-coordinator-experiment.js';
import type { TakeLifecycle } from '../src/take-session.js';

const PRIMARY = 'singer_AAAAA';
const SECONDARY = 'singer_BBBBB';
function fixture() {
  const participants = new ParticipantSession();
  assert.equal(participants.attach({
    connectionId: 'presence-a', participantId: PRIMARY, nickname: 'A', nowMs: 0,
  }), true);
  assert.equal(participants.attach({
    connectionId: 'presence-b', participantId: SECONDARY, nickname: 'B', nowMs: 0,
  }), true);
  assert.equal(participants.acquireMic(PRIMARY).ok, true);
  let takeLifecycle: TakeLifecycle = 'idle';
  let mediaOwnerId: string | null = PRIMARY;
  let connected = true;
  const consents = new Set<string>();
  const consentKey = (id: string, roomEpoch: number) => `${id}@${roomEpoch}`;
  const request: ChoirRestartApproval = {
    actorParticipantId: PRIMARY, primaryId: PRIMARY, secondaryId: SECONDARY,
    expectedRetiredRoomEpoch: 0, expectedPlaybackRevision: 4, nowMs: 10,
  };
  const authorize = (input = request) => authorizeChoirRestartWithLiveRoles(input, {
    participants,
    mic: { mediaOwnerId, controlConnected: () => connected },
    takeLifecycle,
    secondaryConsent: (id, epoch) => consents.has(consentKey(id, epoch)),
  });
  return {
    participants, request, authorize,
    giveConsent: (id = SECONDARY, epoch = 1) => consents.add(consentKey(id, epoch)),
    revokeConsent: (id = SECONDARY, epoch = 1) => consents.delete(consentKey(id, epoch)),
    setOwner: (id: string | null) => { mediaOwnerId = id; },
    setConnected: (v: boolean) => { connected = v; },
    setTake: (v: TakeLifecycle) => { takeLifecycle = v; },
  };
}

describe('Choir experimental role approval uses current Relay Mic owner and B consent', () => {
  test('an authenticated microphone owner is not enough without B explicit consent', () => {
    const f = fixture();
    assert.equal(f.authorize(), false);
    f.giveConsent();
    assert.equal(f.authorize(), true);
    f.revokeConsent();
    assert.equal(f.authorize(), false);
  });

  test('the YouTube leader is not automatically the primary singer or its consent authority', () => {
    const f = fixture();
    f.giveConsent();
    assert.equal(f.authorize({ ...f.request, actorParticipantId: 'robot-leader' }), false);
    assert.equal(f.authorize({ ...f.request, primaryId: SECONDARY, secondaryId: PRIMARY }), false);
    assert.equal(f.authorize({ ...f.request, primaryId: PRIMARY, secondaryId: PRIMARY }), false);
    assert.equal(f.authorize(), true,
      'the real primary may approve while a separate playback leader supplies song clock');
  });

  test('Mic control loss, owner replacement, and participant disconnect all revoke approval', () => {
    const f = fixture();
    f.giveConsent();
    f.setConnected(false);
    assert.equal(f.authorize(), false);
    f.setConnected(true);
    f.setOwner(null);
    assert.equal(f.authorize(), false);
    f.setOwner(PRIMARY);
    assert.equal(f.authorize(), true);
    f.participants.detach('presence-b', 100);
    assert.equal(f.authorize(), false, 'B offline cannot be silently conscripted');
    f.participants.attach({
      connectionId: 'presence-b2', participantId: SECONDARY, nickname: 'B', nowMs: 101,
    });
    assert.equal(f.authorize(), true);
    f.participants.releaseMic(PRIMARY);
    assert.equal(f.authorize(), false, 'a former owner cannot reuse role approval');
  });

  test('Take start/finalize blocks new room even when both singers gave consent', () => {
    const f = fixture();
    f.giveConsent();
    for (const state of ['recording', 'finalizing'] as TakeLifecycle[]) {
      f.setTake(state);
      assert.equal(f.authorize(), false);
    }
    f.setTake('ready');
    assert.equal(f.authorize(), true);
    f.setTake('idle');
    assert.equal(f.authorize(), true);
  });

  test('secondary consent is exact-room scoped and cannot carry to the next epoch', () => {
    const f = fixture();
    f.giveConsent(SECONDARY, 1);
    assert.equal(f.authorize(), true);
    assert.equal(f.authorize({ ...f.request, expectedRetiredRoomEpoch: 1 }), false);
    f.giveConsent(SECONDARY, 2);
    assert.equal(f.authorize({ ...f.request, expectedRetiredRoomEpoch: 1 }), true);
    f.revokeConsent(SECONDARY, 1);
    assert.equal(f.authorize(), false);
  });
});
