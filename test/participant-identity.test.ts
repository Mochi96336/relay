import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { participantIdForCapability } from '../src/participant-capability.js';
import {
  participantIdentityFromAuthentication,
  upgradeRequestNamesParticipant,
} from '../src/participant-identity.js';

describe('participant identity parsing', () => {
  test('an upgrade URL without a participant names nobody', () => {
    assert.equal(
      upgradeRequestNamesParticipant({ url: '/ws?key=room', headers: { host: 'relay.test' } }),
      false,
    );
  });

  test('any participant in the upgrade URL is refused, browser-shaped or not', () => {
    for (const participantId of ['participant-' + 'ab'.repeat(16), 'participant-alice']) {
      assert.equal(
        upgradeRequestNamesParticipant({
          url: '/ws?participant=' + participantId + '&name=Singer',
          headers: { host: 'relay.test' },
        }),
        true,
      );
    }
  });

  test('authenticates browser identity only when the capability derives the same public id', () => {
    const capability = 'ab'.repeat(32);
    const participantId = participantIdForCapability(capability);
    assert.ok(participantId);
    assert.deepEqual(
      participantIdentityFromAuthentication({
        participantId,
        capability,
        nickname: '  Singer  ',
      }),
      { kind: 'valid', participantId, nickname: 'Singer' },
    );
    assert.deepEqual(
      participantIdentityFromAuthentication({
        participantId,
        capability: 'cd'.repeat(32),
        nickname: 'Singer',
      }),
      { kind: 'invalid' },
    );
  });

  test('does not let legacy fixture ids use browser message authentication', () => {
    assert.deepEqual(
      participantIdentityFromAuthentication({
        participantId: 'participant-alice',
        capability: 'ab'.repeat(32),
        nickname: 'Alice',
      }),
      { kind: 'invalid' },
    );
  });
});
