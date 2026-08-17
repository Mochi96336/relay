import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  ParticipantSession,
  normalizeNickname,
  normalizeParticipantId,
} from '../src/participant-session.js';

describe('participant session', () => {
  test('counts multiple transport sockets as one visible participant', () => {
    const session = new ParticipantSession(5_000);

    assert.equal(session.attach({
      connectionId: 'presence-a',
      participantId: 'participant-a',
      nickname: 'Alice',
      nowMs: 100,
    }), true);

    assert.equal(session.attach({
      connectionId: 'publisher-a',
      participantId: 'participant-a',
      nickname: 'Alice',
      nowMs: 110,
    }), false);

    assert.equal(session.snapshot().participants.length, 1);
    assert.equal(session.detach('publisher-a', 120), false, 'presence socket still owns liveness');
    assert.equal(session.snapshot().participants[0].connected, true);
  });

  test('does not let a stale reconnect overwrite an explicit rename', () => {
    const session = new ParticipantSession(5_000);
    session.attach({
      connectionId: 'tab-a',
      participantId: 'participant-alice',
      nickname: 'Alice',
      nowMs: 100,
    });
    assert.equal(session.rename('participant-alice', 'Alicia', 110), true);

    assert.equal(session.attach({
      connectionId: 'stale-tab',
      participantId: 'participant-alice',
      nickname: 'Alice',
      nowMs: 120,
    }), false);
    assert.equal(session.snapshot().participants[0].nickname, 'Alicia');
  });

  test('keeps mic ownership through a short reconnect and releases it after grace expires', () => {
    const session = new ParticipantSession(500);
    session.attach({
      connectionId: 'alice-1',
      participantId: 'participant-alice',
      nickname: 'Alice',
      nowMs: 1_000,
    });
    assert.equal(session.acquireMic('participant-alice').ok, true);

    session.detach('alice-1', 1_100);
    let snapshot = session.snapshot();
    assert.equal(snapshot.micOwnerId, 'participant-alice');
    assert.equal(snapshot.participants[0].connected, false);
    assert.equal(snapshot.participants[0].reconnectingUntil, 1_600);

    assert.deepEqual(session.sweep(1_500), {
      changed: false,
      releasedMicOwnerId: null,
      micOwnerEffects: null,
    });
    session.attach({
      connectionId: 'alice-2',
      participantId: 'participant-alice',
      nickname: 'Alice',
      nowMs: 1_550,
    });
    snapshot = session.snapshot();
    assert.equal(snapshot.micOwnerId, 'participant-alice');
    assert.equal(snapshot.participants[0].connected, true);

    session.detach('alice-2', 2_000);
    assert.deepEqual(session.sweep(2_501), {
      changed: true,
      releasedMicOwnerId: 'participant-alice',
      micOwnerEffects: {
        changed: true,
        noteQualityEvent: 'mic-owner-changed',
        cancelRoomSongCommand: 'mic-owner-released',
        cancelSongHandoff: true,
        invalidateTimingReason: 'Microphone owner left the Relay session.',
        prepareSongHandoffFor: null,
      },
    });
    assert.equal(session.snapshot().micOwnerId, null);
    assert.deepEqual(session.snapshot().participants, []);
  });

  test('requires explicit takeover when another participant owns the mic', () => {
    const session = new ParticipantSession();
    for (const [id, name, connectionId] of [
      ['participant-alice', 'Alice', 'a'],
      ['participant-bobby', 'Bob', 'b'],
    ] as const) {
      session.attach({ connectionId, participantId: id, nickname: name, nowMs: 100 });
    }

    assert.equal(session.acquireMic('participant-alice').ok, true);
    const busy = session.acquireMic('participant-bobby');
    assert.equal(busy.ok, false);
    assert.equal(busy.reason, 'busy');
    assert.equal(busy.effects.changed, false);
    assert.equal(session.micOwnerId, 'participant-alice');

    const takeover = session.takeoverMic('participant-bobby', 'participant-alice');
    assert.equal(takeover.ok, true);
    assert.equal(takeover.previousOwnerId, 'participant-alice');
    assert.deepEqual(takeover.effects, {
      changed: true,
      noteQualityEvent: 'mic-owner-changed',
      cancelRoomSongCommand: 'mic-owner-changed',
      cancelSongHandoff: false,
      invalidateTimingReason: 'Microphone ownership changed.',
      prepareSongHandoffFor: 'participant-bobby',
    });
    assert.equal(session.micOwnerId, 'participant-bobby');
  });

  test('rejects a stale confirmation if the mic changed hands before confirm', () => {
    const session = new ParticipantSession();
    for (const [id, name] of [
      ['participant-alice', 'Alice'],
      ['participant-bobby', 'Bob'],
      ['participant-carol', 'Carol'],
    ] as const) {
      session.attach({ connectionId: id, participantId: id, nickname: name, nowMs: 100 });
    }

    session.acquireMic('participant-alice');
    assert.equal(
      session.takeoverMic('participant-carol', 'participant-alice').ownerId,
      'participant-carol',
    );

    const stale = session.takeoverMic('participant-bobby', 'participant-alice');
    assert.equal(stale.ok, false);
    assert.equal(stale.reason, 'owner-changed');
    assert.equal(stale.ownerId, 'participant-carol');
    assert.equal(stale.effects.changed, false);
    assert.equal(session.micOwnerId, 'participant-carol');
  });

  test('allows a confirmed takeover to become a normal acquire if the observed owner released', () => {
    const session = new ParticipantSession();
    session.attach({ connectionId: 'a', participantId: 'participant-alice', nickname: 'Alice', nowMs: 100 });
    session.attach({ connectionId: 'b', participantId: 'participant-bobby', nickname: 'Bob', nowMs: 100 });
    session.acquireMic('participant-alice');
    const release = session.releaseMic('participant-alice');
    assert.equal(release.effects.cancelRoomSongCommand, 'mic-owner-released');
    assert.equal(release.effects.cancelSongHandoff, true);
    assert.equal(release.effects.invalidateTimingReason, 'Microphone was released.');

    const result = session.takeoverMic('participant-bobby', 'participant-alice');
    assert.equal(result.ok, true);
    assert.equal(result.previousOwnerId, null);
    assert.equal(result.effects.prepareSongHandoffFor, 'participant-bobby');
    assert.equal(session.micOwnerId, 'participant-bobby');
  });

  test('transport grace expiry returns transport-specific room effects', () => {
    const session = new ParticipantSession();
    session.attach({
      connectionId: 'a',
      participantId: 'participant-alice',
      nickname: 'Alice',
      nowMs: 100,
    });
    session.acquireMic('participant-alice');

    const release = session.releaseMic('participant-alice', 'transport-expired');
    assert.equal(release.ok, true);
    assert.deepEqual(release.effects, {
      changed: true,
      noteQualityEvent: 'mic-owner-changed',
      cancelRoomSongCommand: 'mic-owner-released',
      cancelSongHandoff: false,
      invalidateTimingReason: 'Microphone transport did not reconnect before its grace period expired.',
      prepareSongHandoffFor: null,
    });
  });

  test('sanitizes identity inputs without turning a nickname into authentication', () => {
    assert.equal(normalizeParticipantId('participant_123'), 'participant_123');
    assert.equal(normalizeParticipantId('short'), null);
    assert.equal(normalizeParticipantId('../escape'), null);
    assert.equal(normalizeNickname('  Mochi   Panda  '), 'Mochi Panda');
    assert.equal(normalizeNickname('   '), null);
    assert.equal(Array.from(normalizeNickname('x'.repeat(80)) ?? '').length, 32);
  });
});
