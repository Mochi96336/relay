import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { participantIdForCapability } from '../src/participant-capability.js';
import {
  participantIdentityFromAuthentication,
  participantIdentityFromUpgradeRequest,
} from '../src/participant-identity.js';

describe('participant identity parsing', () => {
  test('treats an upgrade without participant query identity as unauthenticated', () => {
    assert.deepEqual(
      participantIdentityFromUpgradeRequest({ url: '/ws', headers: { host: 'relay.test' } }),
      { kind: 'none' },
    );
  });

  test('never accepts a browser participant identity from the upgrade URL', () => {
    const participantId = 'participant-' + 'ab'.repeat(16);
    assert.deepEqual(
      participantIdentityFromUpgradeRequest({
        url: '/ws?participant=' + participantId + '&name=Singer',
        headers: { host: 'relay.test' },
      }),
      { kind: 'invalid' },
    );
  });

  test('keeps legacy query identity test-only', () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousLegacyGate = process.env.RELAY_TEST_LEGACY_PARTICIPANTS;
    try {
      process.env.NODE_ENV = 'production';
      process.env.RELAY_TEST_LEGACY_PARTICIPANTS = '1';
      assert.deepEqual(
        participantIdentityFromUpgradeRequest({
          url: '/ws?participant=participant-alice&name=Alice',
          headers: { host: 'relay.test' },
        }),
        { kind: 'invalid' },
      );

      process.env.NODE_ENV = 'test';
      process.env.RELAY_TEST_LEGACY_PARTICIPANTS = '1';
      assert.deepEqual(
        participantIdentityFromUpgradeRequest({
          url: '/ws?participant=participant-alice&name=%20Alice%20',
          headers: { host: 'relay.test' },
        }),
        { kind: 'valid', participantId: 'participant-alice', nickname: 'Alice' },
      );
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousLegacyGate === undefined) delete process.env.RELAY_TEST_LEGACY_PARTICIPANTS;
      else process.env.RELAY_TEST_LEGACY_PARTICIPANTS = previousLegacyGate;
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
