import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ChoirSecondaryConsentExperiment } from '../src/choir-secondary-consent-experiment.js';

type Socket = { participantId?: string; open: boolean };
const A = 'participant-AAAAAAA1';
const B = 'participant-BBBBBBB2';
const C = 'participant-CCCCCCC3';
function fixture() {
  const a: Socket = { participantId: A, open: true };
  const b: Socket = { participantId: B, open: true };
  const anotherB: Socket = { participantId: B, open: true };
  const c: Socket = { participantId: C, open: true };
  let owner: string | null = A;
  let liveMedia = true;
  let bConnected = true;
  let cConnected = true;
  const delivered: Array<{ target: string; payload: Record<string, unknown> }> = [];
  const consent = new ChoirSecondaryConsentExperiment({
    primaryStillOwnsMic: id => id === owner && liveMedia,
    holdsMic: id => id === owner,
    participantConnected: id => (id === B && bConnected) || (id === C && cConnected),
    socketOpen: socket => (socket as Socket).open,
    notifySocket: (socket, payload) =>
      delivered.push({ target: (socket as Socket).participantId ?? '', payload }),
  });
  return {
    a, b, anotherB, c, consent, delivered,
    secondary: () => consent.active()?.secondaryId ?? null,
    changeOwner: (v: string | null) => { owner = v; },
    setLiveMedia: (v: boolean) => { liveMedia = v; },
    changeBPresence: (v: boolean) => { bConnected = v; },
    changeCPresence: (v: boolean) => { cConnected = v; },
  };
}

describe('B joins the Mic owner by its own press', () => {
  test('a join needs no song and lasts until something ends it', () => {
    const f = fixture();
    assert.equal(f.consent.join(f.b, A), true);
    assert.deepEqual(f.consent.active(), { primaryId: A, secondaryId: B, socket: f.b });
    assert.equal(f.delivered.at(-1)?.target, B);
    assert.equal(f.delivered.at(-1)?.payload.status, 'accepted');
    assert.equal(f.delivered.at(-1)?.payload.joined, true);
    assert.equal(f.consent.sweep(), false, 'nothing to end');
    assert.equal(f.secondary(), B);
  });

  test('nobody can join without another Mic owner whose media is live', () => {
    const f = fixture();
    assert.equal(f.consent.join(f.b, null), false, 'no Mic owner');
    assert.equal(f.consent.join(f.a, A), false, 'the Mic owner is not their own second singer');
    assert.equal(f.consent.join({ open: true }, A), false, 'an unauthenticated socket');
    assert.equal(f.consent.join({ participantId: B, open: false }, A), false, 'a closed socket');
    f.setLiveMedia(false);
    assert.equal(f.consent.join(f.b, A), false, 'A is not sending yet');
    f.setLiveMedia(true);
    assert.equal(f.consent.join(f.b, A), true);
    const notices = f.delivered.length;
    assert.equal(f.consent.join(f.b, A), true, 'joining again is a no-op');
    assert.equal(f.delivered.length, notices, 'and says nothing new');
  });

  test('only the socket B joined from speaks for B, not another tab of the same participant', () => {
    const f = fixture();
    assert.equal(f.consent.isJoinSocket(f.b), false, 'nobody joined yet');
    assert.equal(f.consent.join(f.b, A), true);
    assert.equal(f.consent.isJoinSocket(f.b), true);
    assert.equal(f.consent.isJoinSocket(f.anotherB), false, 'same participant, other tab');
    assert.equal(f.consent.isJoinSocket(f.c), false);
    assert.equal(f.consent.isJoinSocket(f.a), false, 'the Mic owner');
    assert.equal(f.consent.withdraw(f.anotherB), false, 'another tab cannot leave for B');
    assert.equal(f.consent.withdraw(f.b), true);
    assert.equal(f.consent.isJoinSocket(f.b), false, 'B left');
  });

  test('the join ends when A gives up the Mic, B goes away or B leaves', () => {
    const owner = fixture();
    owner.consent.join(owner.b, A);
    owner.changeOwner(C);
    assert.equal(owner.consent.active(), null);
    assert.equal(owner.delivered.at(-1)?.payload.reason, 'scope-or-authority-changed');

    const presence = fixture();
    presence.consent.join(presence.b, A);
    presence.changeBPresence(false);
    assert.equal(presence.consent.active(), null);

    const closed = fixture();
    closed.consent.join(closed.b, A);
    closed.b.open = false;
    assert.equal(closed.consent.disconnected(closed.anotherB), false, 'another tab closing is not B');
    assert.equal(closed.consent.disconnected(closed.b), true);
    assert.equal(closed.consent.active(), null);

    const left = fixture();
    left.consent.join(left.b, A);
    assert.equal(left.consent.withdraw(left.b), true);
    assert.equal(left.consent.active(), null);
  });
});

test('a join follows the Mic owner through a media or control hiccup', () => {
  const f = fixture();
  assert.equal(f.consent.join(f.b, A), true);
  f.setLiveMedia(false);
  assert.equal(f.secondary(), B, 'A reconnecting keeps B in');
  f.changeOwner(C);
  assert.equal(f.consent.active(), null, 'a new Mic owner ends it');
});

test('anyone else can take over the second Mic; the singer replaced is told so', () => {
  const f = fixture();
  assert.equal(f.consent.join(f.b, A), true);
  assert.equal(f.consent.join(f.c, A), true, 'C takes over, as the Mic can be taken over');
  assert.equal(f.secondary(), C);
  const notice = f.delivered.find((d) => d.payload.status === 'revoked');
  assert.equal(notice?.target, B);
  assert.equal(notice?.payload.reason, 'replaced');
  assert.equal(f.consent.isJoinSocket(f.b), false, 'the replaced B has nothing left');
});

test('B joining again from another tab moves the join there, without a revocation', () => {
  const f = fixture();
  assert.equal(f.consent.join(f.b, A), true);
  assert.equal(f.consent.join(f.anotherB, A), true);
  assert.equal(f.consent.isJoinSocket(f.anotherB), true);
  assert.equal(f.consent.isJoinSocket(f.b), false);
  assert.equal(f.delivered.some((d) => d.payload.status === 'revoked'), false);
});

test('a reconnecting B cannot automatically take the seat from a new second singer', () => {
  const f = fixture();
  assert.equal(f.consent.join(f.b, A), true);
  f.b.open = false;
  f.consent.disconnected(f.b);
  assert.equal(f.consent.join(f.c, A), true);
  assert.equal(f.consent.join(f.anotherB, A, { resume: true }), false);
  assert.equal(f.secondary(), C);
  assert.equal(f.consent.join(f.anotherB, A), true, 'an explicit press can still take over');
});

test('a fresh authenticated B can resume an empty seat after control disconnect', () => {
  const f = fixture();
  assert.equal(f.consent.join(f.b, A), true);
  f.b.open = false;
  f.consent.disconnected(f.b);
  assert.equal(f.consent.active(), null);
  assert.equal(f.consent.join(f.anotherB, A, { resume: true }), true);
  assert.equal(f.secondary(), B);
});
