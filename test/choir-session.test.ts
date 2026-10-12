import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ChoirSession } from '../src/choir-session.js';

describe('experimental choir seating and controller separation', () => {
  const A = 'participant-alice';
  const B = 'participant-bobby';
  const C = 'participant-carol';

  test('a secondary joins without stealing the primary microphone or song authority', () => {
    const choir = new ChoirSession(3);
    assert.deepEqual(choir.claimPrimary(A, null), { ok: true, changed: true });
    assert.deepEqual(choir.joinSecondary(B), { ok: true, changed: true });
    assert.deepEqual(choir.joinSecondary(C), { ok: true, changed: true });
    assert.deepEqual(choir.snapshot(), {
      revision: 3, primaryMicId: A, secondaryMicIds: [B, C],
      singerIds: [A, B, C], songControllerId: A, maxSingers: 3,
    });
    assert.equal(choir.seatOf(B), 'secondary');
  });

  test('primary loss NEVER automatically promotes or disconnects secondaries', () => {
    const choir = new ChoirSession(3);
    choir.claimPrimary(A, null);
    choir.joinSecondary(B);
    choir.joinSecondary(C);
    assert.deepEqual(choir.leaveSinger(A), { ok: true, changed: true });
    assert.deepEqual(choir.snapshot(), {
      revision: 4, primaryMicId: null, secondaryMicIds: [B, C],
      singerIds: [B, C], songControllerId: A, maxSingers: 3,
    });
    assert.equal(choir.seatOf(B), 'secondary');
    assert.deepEqual(choir.joinSecondary('participant-dan'), {
      ok: false, changed: false, reason: 'primary-required',
    });
    assert.equal(choir.primaryMicId, null, 'no implicit succession');
  });

  test('secondary promotion requires an explicit Take Mic action', () => {
    const choir = new ChoirSession(3);
    choir.claimPrimary(A, null);
    choir.joinSecondary(B);
    choir.joinSecondary(C);
    choir.leaveSinger(A);
    assert.deepEqual(choir.claimPrimary(B, null), { ok: true, changed: true });
    assert.equal(choir.primaryMicId, B);
    assert.deepEqual(choir.snapshot().secondaryMicIds, [C]);
    assert.equal(choir.songControllerId, A, 'mic takeover is not an implicit song handoff');
  });

  test('explicit takeover replaces only primary, preserving other secondary seats', () => {
    const choir = new ChoirSession(3);
    choir.claimPrimary(A, null);
    choir.joinSecondary(B);
    choir.joinSecondary(C);
    assert.deepEqual(choir.claimPrimary(B, A), { ok: true, changed: true });
    assert.equal(choir.primaryMicId, B);
    assert.deepEqual(choir.snapshot().secondaryMicIds, [C]);
    assert.equal(choir.seatOf(A), null);
    assert.equal(choir.songControllerId, A);
  });

  test('stale takeover cannot change the current primary', () => {
    const choir = new ChoirSession(2);
    choir.claimPrimary(A, null);
    assert.deepEqual(choir.claimPrimary(C, null), {
      ok: false, changed: false, reason: 'primary-changed',
    });
    assert.equal(choir.primaryMicId, A);
    assert.deepEqual(choir.claimPrimary(A, A), { ok: true, changed: false });
  });

  test('reconnect/idempotent joins preserve revision and room capacity', () => {
    const choir = new ChoirSession(2);
    choir.claimPrimary(A, null);
    choir.joinSecondary(B);
    const before = choir.revision;
    assert.deepEqual(choir.joinSecondary(B), { ok: true, changed: false });
    assert.equal(choir.revision, before);
    assert.deepEqual(choir.joinSecondary(C), {
      ok: false, changed: false, reason: 'room-full',
    });
    assert.deepEqual(choir.claimPrimary(C, A), { ok: true, changed: true });
    assert.deepEqual(choir.snapshot().secondaryMicIds, [B]);
    assert.deepEqual(choir.claimPrimary(A, C), { ok: true, changed: true });
    assert.deepEqual(choir.snapshot().secondaryMicIds, [B]);
  });

  test('controller handoff requires a separate explicit compare-and-swap', () => {
    const choir = new ChoirSession(2);
    choir.claimPrimary(A, null);
    choir.joinSecondary(B);
    assert.deepEqual(choir.setSongController(B, null), {
      ok: false, changed: false, reason: 'controller-changed',
    });
    assert.equal(choir.songControllerId, A);
    assert.deepEqual(choir.setSongController(B, A), { ok: true, changed: true });
    choir.leaveSinger(A);
    assert.equal(choir.songControllerId, B);
    choir.leaveSinger(B);
    assert.equal(choir.songControllerId, B);
    assert.deepEqual(choir.setSongController(null, B), { ok: true, changed: true });
    assert.equal(choir.songControllerId, null);
  });

  test('secondary without primary and invalid participants are rejected', () => {
    const choir = new ChoirSession();
    assert.deepEqual(choir.joinSecondary(B), {
      ok: false, changed: false, reason: 'primary-required',
    });
    assert.deepEqual(choir.claimPrimary(' ', null), {
      ok: false, changed: false, reason: 'invalid-participant',
    });
    assert.deepEqual(choir.joinSecondary(A), {
      ok: false, changed: false, reason: 'primary-required',
    });
    choir.claimPrimary(A, null);
    assert.deepEqual(choir.joinSecondary(A), {
      ok: false, changed: false, reason: 'already-primary',
    });
    assert.throws(() => new ChoirSession(1), RangeError);
  });
});
