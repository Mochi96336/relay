import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { authorizeMicOwnerCommand } from '../src/command-authority.js';

describe('mic owner command authority', () => {
  test('accepts any transport attached to the current Mic owner', () => {
    assert.deepEqual(
      authorizeMicOwnerCommand(
        { participantId: 'participant-owner' },
        'participant-owner',
      ),
      { ok: true, authority: 'mic-owner' },
    );
  });

  test('rejects another participant', () => {
    assert.deepEqual(
      authorizeMicOwnerCommand(
        { participantId: 'participant-other' },
        'participant-owner',
      ),
      { ok: false, reason: 'not-mic-owner' },
    );
  });

  test('lets any identified participant adjust a room nobody is singing in', () => {
    assert.deepEqual(
      authorizeMicOwnerCommand(
        { participantId: 'participant-listener' },
        null,
      ),
      { ok: true, authority: 'room-open' },
    );
  });

  test('gives a socket without a participant identity no authority', () => {
    assert.deepEqual(
      authorizeMicOwnerCommand({ participantId: null }, null),
      { ok: false, reason: 'no-identity' },
    );
    assert.deepEqual(
      authorizeMicOwnerCommand({ participantId: null }, 'participant-owner'),
      { ok: false, reason: 'not-mic-owner' },
    );
  });
});
