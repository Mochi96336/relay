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
