import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  ChoirSecondaryConsentExperiment,
  type ChoirConsentScope,
} from '../src/choir-secondary-consent-experiment.js';

type Socket = { participantId?: string; open: boolean };
const A = 'participant-AAAAAAA1';
const B = 'participant-BBBBBBB2';
const C = 'participant-CCCCCCC3';
function fixture() {
  const a: Socket = { participantId: A, open: true };
  const b: Socket = { participantId: B, open: true };
  const anotherB: Socket = { participantId: B, open: true };
  const attacker: Socket = { participantId: C, open: true };
  let primary = A;
  let bConnected = true;
  let recording = false;
  let scope: ChoirConsentScope | null = {
    roomEpoch: 1, playbackRevision: 5, videoId: 'abcdefghijk',
    backingGeneration: 9, robotSourceGeneration: 7,
  };
  const delivered: Array<{target: string; payload: Record<string, unknown>}> = [];
  const consent = new ChoirSecondaryConsentExperiment({
    scopeNow: () => scope,
    primaryStillOwnsMic: id => id === primary && a.open,
    participantConnected: id => id === B && bConnected,
    takeFrozenNow: () => recording,
    socketOpen: socket => (socket as Socket).open,
    notifyParticipant: (id, payload) => delivered.push({target: id, payload}),
    notifySocket: (socket, payload) =>
      delivered.push({target: (socket as Socket).participantId ?? '', payload}),
  });
  const invite = (time = 0) => consent.invite(a, B, time);
  return {
    a,b,anotherB,attacker,consent,delivered,invite,
    setScope: (v: ChoirConsentScope | null) => { scope = v; },
    changeScope: (v: Partial<ChoirConsentScope>) => { scope = scope ? {...scope,...v} : null; },
    changeOwner: (v: string) => { primary = v; },
    changeBPresence: (v: boolean) => { bConnected = v; },
    setRecording: (v: boolean) => { recording = v; },
  };
}

describe('default-off Choir B secondary consent state machine', () => {
  test('A invitation is NOT consent: only B explicitly accepts for exact room and can withdraw', () => {
    const f = fixture();
    const id = f.invite()!;
    assert.ok(id);
    assert.equal(f.consent.pendingCount, 1);
    assert.equal(f.consent.hasConsent(A, B, 1, 10), false);
    const invitations = f.delivered.filter(v => v.payload.type === 'choir-secondary-invitation');
    assert.equal(invitations.length, 1);
    assert.equal(invitations[0].target, B);
    assert.equal(invitations[0].payload.inviteId, id);
    assert.equal(f.consent.respond(f.b, id, true, 20), true);
    assert.equal(f.consent.hasConsent(A, B, 1, 21), true);
    assert.equal(f.consent.hasConsent(A, B, 2, 21), false);
    assert.equal(f.consent.hasConsent(A, C, 1, 21), false);
    assert.equal(f.consent.hasConsent(C, B, 1, 21), false);
    assert.equal(f.consent.hasConsent(A, B, 1, 35_000), true,
      'an accepted room-scoped consent is NOT a 30-second media timeout');
    assert.equal(f.consent.withdraw(f.anotherB, 35_010), false,
      'another browser tab must not withdraw the consenting socket');
    assert.equal(f.consent.withdraw(f.b, 35_020), true);
    assert.equal(f.consent.hasConsent(A, B, 1, 35_030), false);
    assert.equal(f.consent.pendingCount, 0);
  });

  test('forged actor, identity mismatch, unknown invitation and uninvited B cannot consent', () => {
    const f = fixture();
    assert.equal(f.consent.invite(f.attacker, B, 0), null);
    const anonymous: Socket = { open: true };
    assert.equal(f.consent.invite(anonymous, B, 0), null);
    assert.equal(f.consent.invite(f.a, A, 0), null);
    const id = f.invite()!;
    assert.equal(f.consent.respond(f.attacker, id, true, 10), false);
    assert.equal(f.consent.respond(f.b, 'some-unknown-id', true, 10), false);
    const unauthenticated: Socket = { open: true };
    assert.equal(f.consent.respond(unauthenticated, id, true, 10), false);
    assert.equal(f.consent.respond(f.b, id, true, 11), true);
    assert.equal(f.consent.respond(f.anotherB, id, true, 12), false,
      'the consent-bearing physical socket must not change on retry');
    assert.equal(f.consent.respond(f.anotherB, id, false, 12), false,
      'a stale decline on another B tab cannot withdraw accepted consent');
    assert.equal(f.consent.hasConsent(A, B, 1, 12), true);
    assert.equal(f.consent.respond(f.b, id, false, 12), false,
      'accepted consent must use the explicit withdraw action');
    assert.equal(f.consent.respond(f.b, id, true, 13), true,
      'a duplicate response from the SAME connected B socket is idempotent');
    assert.equal(f.delivered.filter(v => v.payload.type === 'choir-secondary-consent-status'
      && v.payload.status === 'accepted').length, 2,
      'idempotent retry must not deliver a second acceptance notification');
  });

  test('decline, unaccepted expiry and duplicate invitations do not grant authority', () => {
    const f = fixture();
    const first = f.invite(10)!;
    assert.equal(f.invite(11), first);
    assert.equal(f.delivered.filter(v => v.payload.type === 'choir-secondary-invitation').length, 1);
    assert.equal(f.consent.respond(f.b, first, false, 12), true);
    assert.equal(f.consent.hasConsent(A, B, 1, 13), false);
    const second = f.invite(14)!;
    assert.notEqual(second, first);
    assert.equal(f.consent.respond(f.b, first, true, 20), false);
    assert.equal(f.consent.sweep(30_015), 1);
    assert.equal(f.consent.respond(f.b, second, true, 30_016), false);
    assert.equal(f.consent.pendingCount, 0);
  });

  test('any accepted song mapping change invalidates BOTH pending invitations and granted B consent', () => {
    for (const change of [
      { playbackRevision: 6 }, { roomEpoch: 2 },
      { videoId: 'mnopqrstuvw' }, { backingGeneration: 10 },
      { robotSourceGeneration: 8 },
    ]) {
      const f = fixture();
      const id = f.invite(0)!;
      assert.equal(f.consent.respond(f.b, id, true, 10), true);
      f.changeScope(change);
      assert.equal(f.consent.hasConsent(A, B, 1, 20), false, JSON.stringify(change));
      assert.equal(f.consent.pendingCount, 0);
      assert.equal(f.delivered.some(item =>
        item.payload.type === 'choir-secondary-consent-status'
        && item.payload.status === 'revoked'
        && item.payload.reason === 'scope-or-authority-changed'), true,
      'both participants are told their accepted room consent is revoked');
      assert.equal(f.consent.respond(f.b, id, true, 21), false);
    }
    const pending = fixture();
    const id = pending.invite(0)!;
    pending.setScope(null);
    assert.equal(pending.consent.respond(pending.b, id, true, 10), false);
  });

  test('physical B disconnection notifies the surviving primary of the revocation', () => {
    const f = fixture();
    const id = f.invite(0)!;
    assert.equal(f.consent.respond(f.b, id, true, 10), true);
    f.b.open = false;
    assert.equal(f.consent.disconnected(f.b), true);
    assert.equal(f.consent.hasConsent(A, B, 1, 11), false);
    assert.equal(f.delivered.some(item => item.target === A
      && item.payload.status === 'revoked'
      && item.payload.reason === 'connection-closed'), true);
  });

  test('Take start, Mic lease loss, B presence loss, physical B close and A close each revoke consent', () => {
    for (const loss of ['take', 'owner', 'b-presence', 'b-close', 'a-close'] as const) {
      const f = fixture();
      const id = f.invite(0)!;
      assert.equal(f.consent.respond(f.b, id, true, 10), true);
      switch (loss) {
        case 'take': f.setRecording(true); break;
        case 'owner': f.changeOwner(C); break;
        case 'b-presence': f.changeBPresence(false); break;
        case 'b-close': f.b.open = false; break;
        case 'a-close': f.a.open = false; break;
      }
      assert.equal(f.consent.hasConsent(A, B, 1, 20), false, loss);
      assert.equal(f.consent.pendingCount, 0);
      assert.equal(f.consent.respond(f.b, id, true, 21), false);
    }
    const socketClose = fixture();
    const id = socketClose.invite(0)!;
    socketClose.consent.respond(socketClose.b, id, true, 10);
    assert.equal(socketClose.consent.disconnected(socketClose.b), true);
    assert.equal(socketClose.consent.disconnected(socketClose.b), false);
    assert.equal(socketClose.consent.hasConsent(A, B, 1, 20), false);
  });
});

describe('B joins the Mic owner by its own press', () => {
  test('joining needs no song and survives pauses, seeks, song changes and Takes', () => {
    const f = fixture();
    f.setScope(null);
    assert.equal(f.consent.join(f.b, A, 0), true);
    assert.deepEqual(f.consent.activeJoin(0), { primaryId: A, secondaryId: B });
    assert.equal(f.delivered.at(-1)?.payload.status, 'accepted');
    assert.equal(f.delivered.at(-1)?.payload.joined, true);
    // Any room the server creates for this pair carries the join.
    for (const roomEpoch of [1, 2, 7]) assert.equal(f.consent.hasConsent(A, B, roomEpoch, 10), true);
    assert.equal(f.consent.hasConsentOnSocket(A, B, 2, f.b, 10), true);
    assert.equal(f.consent.hasConsentOnSocket(A, B, 2, f.anotherB, 10), false, 'only the tab that joined');
    f.setScope({ roomEpoch: 3, playbackRevision: 9, videoId: 'zyxwvutsrqp', backingGeneration: 1, robotSourceGeneration: 2 });
    f.setRecording(true);
    assert.deepEqual(f.consent.activeJoin(60_000), { primaryId: A, secondaryId: B });
  });

  test('nobody can join without another Mic owner, nor while a different B is in', () => {
    const f = fixture();
    assert.equal(f.consent.join(f.b, null, 0), false, 'no Mic owner');
    assert.equal(f.consent.join(f.a, A, 0), false, 'the Mic owner is not their own second singer');
    assert.equal(f.consent.join(f.b, A, 0), true);
    assert.equal(f.consent.join(f.b, A, 1), true, 'joining again is a no-op');
    assert.equal(f.consent.join(f.attacker, A, 2), false, 'one second singer per Mic owner');
    assert.equal(f.consent.activeJoin(3)?.secondaryId, B);
  });

  test('the join ends when A gives up the Mic, B disconnects or B leaves', () => {
    const owner = fixture();
    owner.consent.join(owner.b, A, 0);
    owner.changeOwner(C);
    assert.equal(owner.consent.activeJoin(1), null);

    const presence = fixture();
    presence.consent.join(presence.b, A, 0);
    presence.changeBPresence(false);
    assert.equal(presence.consent.activeJoin(1), null);

    const closed = fixture();
    closed.consent.join(closed.b, A, 0);
    closed.b.open = false;
    assert.equal(closed.consent.disconnected(closed.b), true);
    assert.equal(closed.consent.activeJoin(1), null);

    const left = fixture();
    left.consent.join(left.b, A, 0);
    assert.equal(left.consent.withdraw(left.b, 1), true);
    assert.equal(left.consent.activeJoin(2), null);
    assert.equal(left.consent.hasConsent(A, B, 1, 2), false);
  });
});

test('a join follows the Mic owner through a media or control hiccup', () => {
  const a = { participantId: 'participant-AAAAAAA1', open: true };
  const b = { participantId: 'participant-BBBBBBB2', open: true };
  let owner: string | null = a.participantId;
  let liveMedia = true;
  const consent = new ChoirSecondaryConsentExperiment({
    scopeNow: () => null,
    primaryStillOwnsMic: (id) => id === owner && liveMedia,
    holdsMic: (id) => id === owner,
    participantConnected: () => true,
    takeFrozenNow: () => false,
    socketOpen: (socket) => (socket as { open: boolean }).open,
    notifyParticipant: () => {},
    notifySocket: () => {},
  });
  assert.equal(consent.join(b, a.participantId, 0), true);
  liveMedia = false;
  assert.deepEqual(consent.activeJoin(1)?.secondaryId, b.participantId, 'A reconnecting keeps B in');
  owner = 'participant-CCCCCCC3';
  assert.equal(consent.activeJoin(2), null, 'a new Mic owner ends it');
});
