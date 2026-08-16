import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { authorizeMicOwnerCommand } from '../src/command-authority.js';

describe('mic owner command authority', () => {
  test('accepts any transport attached to the current Mic owner', () => {
    assert.deepEqual(
      authorizeMicOwnerCommand(
        { participantId: 'participant-owner', isCurrentPublisher: false },
        'participant-owner',
      ),
      { ok: true, authority: 'mic-owner' },
    );
  });

  test('rejects another participant even if that socket is a publisher transport', () => {
    assert.deepEqual(
      authorizeMicOwnerCommand(
        { participantId: 'participant-other', isCurrentPublisher: true },
        'participant-owner',
      ),
      { ok: false, reason: 'not-mic-owner' },
    );
  });

  test('keeps exactly one pre-participant compatibility path', () => {
    assert.deepEqual(
      authorizeMicOwnerCommand(
        { participantId: null, isCurrentPublisher: true },
        null,
      ),
      { ok: true, authority: 'legacy-publisher' },
    );
  });

  test('lets any identified participant adjust a room nobody is singing in', () => {
    assert.deepEqual(
      authorizeMicOwnerCommand(
        { participantId: 'participant-listener', isCurrentPublisher: false },
        null,
      ),
      { ok: true, authority: 'room-open' },
    );
  });

  test('does not let an arbitrary anonymous socket control a legacy session', () => {
    assert.deepEqual(
      authorizeMicOwnerCommand(
        { participantId: null, isCurrentPublisher: false },
        null,
      ),
      { ok: false, reason: 'no-identity' },
    );
  });

  test('does not let the legacy publisher bypass a real participant owner', () => {
    assert.deepEqual(
      authorizeMicOwnerCommand(
        { participantId: null, isCurrentPublisher: true },
        'participant-owner',
      ),
      { ok: false, reason: 'not-mic-owner' },
    );
  });
});
