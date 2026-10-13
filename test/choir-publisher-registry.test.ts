import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ChoirSession } from '../src/choir-session.js';
import { ChoirPublisherRegistry } from '../src/choir-publisher-registry.js';

const A = 'participant-a', B = 'participant-b', C = 'participant-c';
function subject() {
  const seats = new ChoirSession(3);
  const registry = new ChoirPublisherRegistry(seats, 2_000);
  const admit = (id: string, transportId: string, seat: 'primary' | 'secondary',
    expectedPrimaryId: string | null = null, nowMs = 0) => registry.admit({
      authenticatedParticipantId: id, transportId, seat, expectedPrimaryId, nowMs,
    });
  return { seats, registry, admit };
}

describe('choir publisher admission and independent reconnect grace', () => {
  test('A primary and B secondary can upload with separate validated media epochs', () => {
    const { seats, registry, admit } = subject();
    const a = admit(A, 'mic-a-1', 'primary');
    const b = admit(B, 'mic-b-1', 'secondary');
    assert.equal(a.ok, true); assert.equal(b.ok, true);
    if (!a.ok || !b.ok) return;
    assert.ok(a.mediaEpoch !== b.mediaEpoch);
    assert.equal(registry.mayAcceptMedia(A, 'mic-a-1', a.mediaEpoch), true);
    assert.equal(registry.mayAcceptMedia(A, 'mic-b-1', b.mediaEpoch), false);
    assert.equal(registry.mayAcceptMedia(B, 'mic-b-1', b.mediaEpoch), true);
    assert.equal(seats.primaryMicId, A);
    assert.equal(seats.seatOf(B), 'secondary');
  });

  test('A disconnect starts its own grace; B stays live; NO automatic promotion', () => {
    const { seats, registry, admit } = subject();
    const a = admit(A, 'mic-a-1', 'primary');
    const b = admit(B, 'mic-b-1', 'secondary');
    assert.equal(a.ok, true); assert.equal(b.ok, true);
    if (!a.ok || !b.ok) return;
    assert.equal(registry.disconnect('mic-a-1', 100), true);
    assert.equal(registry.mayAcceptMedia(A, 'mic-a-1', a.mediaEpoch), false);
    assert.equal(registry.mayAcceptMedia(B, 'mic-b-1', b.mediaEpoch), true);
    assert.deepEqual(registry.sweep(2_099), []);
    assert.equal(seats.primaryMicId, A);
    assert.deepEqual(registry.sweep(2_100), [A]);
    assert.equal(seats.primaryMicId, null);
    assert.equal(seats.songControllerId, A, 'Mic expiry does not transfer song control');
    assert.equal(seats.seatOf(B), 'secondary');
    assert.equal(registry.mayAcceptMedia(B, 'mic-b-1', b.mediaEpoch), true);
    assert.deepEqual(registry.sweep(2_100), []);
  });

  test('reconnect after expired grace is not a retained lease or implicit primary promotion', () => {
    const { registry, seats, admit } = subject();
    assert.equal(admit(A, 'mic-a1', 'primary').ok, true);
    assert.equal(admit(B, 'mic-b1', 'secondary').ok, true);
    assert.equal(registry.disconnect('mic-a1', 10), true);
    assert.deepEqual(admit(A, 'mic-a2', 'primary', A, 2011), {
      ok: false, reason: 'seat-rejected',
    }, 'stale observed primary cannot reassert itself after grace expired');
    assert.equal(seats.primaryMicId, null);
    assert.equal(seats.seatOf(B), 'secondary');
    assert.equal(seats.songControllerId, A);
    const explicit = admit(A, 'mic-a2', 'primary', null, 2012);
    assert.equal(explicit.ok, true, 'user explicitly takes the vacant primary seat');
    if (!explicit.ok) return;
    assert.equal(explicit.resumed, false, 'this is new admission');
  });

  test('A reconnect supersedes only its own transport; old packet or close is rejected', () => {
    const { registry, admit } = subject();
    const a = admit(A, 'mic-a-1', 'primary');
    const b = admit(B, 'mic-b-1', 'secondary');
    if (!a.ok || !b.ok) throw Error('setup failed');
    registry.disconnect('mic-a-1', 100);
    const reconnected = admit(A, 'mic-a-2', 'primary', A, 500);
    assert.equal(reconnected.ok, true);
    if (!reconnected.ok) return;
    assert.equal(reconnected.resumed, true);
    assert.equal(registry.mayAcceptMedia(A, 'mic-a-1', a.mediaEpoch), false);
    assert.equal(registry.mayAcceptMedia(A, 'mic-a-2', reconnected.mediaEpoch), true);
    assert.equal(registry.disconnect('mic-a-1', 600), false);
    assert.deepEqual(registry.sweep(2_200), []);
    assert.equal(registry.mayAcceptMedia(B, 'mic-b-1', b.mediaEpoch), true);
  });

  test('B explicit Take Mic evicts only A, keeps unrelated C, and retains song authority', () => {
    const { seats, registry, admit } = subject();
    assert.equal(admit(A, 'mic-a-1', 'primary').ok, true);
    assert.equal(admit(B, 'mic-b-1', 'secondary').ok, true);
    const c = admit(C, 'mic-c-1', 'secondary');
    if (!c.ok) throw Error('setup failed');
    const promoted = admit(B, 'mic-b-2', 'primary', A, 200);
    assert.equal(promoted.ok, true);
    if (!promoted.ok) return;
    assert.equal(promoted.revokedParticipantId, A);
    assert.equal(seats.primaryMicId, B);
    assert.equal(seats.seatOf(C), 'secondary');
    assert.equal(registry.mayAcceptMedia(A, 'mic-a-1', 1), false);
    assert.equal(registry.mayAcceptMedia(C, 'mic-c-1', c.mediaEpoch), true);
    assert.equal(seats.songControllerId, A, 'Mic control and playback controller remain distinct');
  });

  test('stale CAS cannot take control and existing publisher retains authority', () => {
    const { seats, registry, admit } = subject();
    const a = admit(A, 'mic-a-1', 'primary');
    assert.equal(a.ok, true);
    const bad = admit(B, 'mic-b-1', 'primary', null);
    assert.deepEqual(bad, { ok: false, reason: 'seat-rejected' });
    assert.equal(seats.primaryMicId, A);
    assert.equal(registry.snapshot().length, 1);
  });

  test('explicit release of B does not release or change A', () => {
    const { seats, registry, admit } = subject();
    const a = admit(A, 'mic-a-1', 'primary');
    admit(B, 'mic-b-1', 'secondary');
    if (!a.ok) throw Error('setup failed');
    assert.equal(registry.release(B), true);
    assert.equal(seats.primaryMicId, A);
    assert.equal(registry.mayAcceptMedia(A, 'mic-a-1', a.mediaEpoch), true);
    assert.equal(registry.release(B), false);
  });

  test('transport cannot be claimed by another authenticated participant', () => {
    const { registry, admit } = subject();
    admit(A, 'mic-shared', 'primary');
    assert.deepEqual(admit(B, 'mic-shared', 'secondary'), {
      ok: false, reason: 'transport-in-use',
    });
  });
});
