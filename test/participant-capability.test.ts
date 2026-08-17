import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import {
  browserParticipantIdentity,
  normalizeParticipantCapability,
  participantCapabilityMatches,
  participantIdForCapability,
} from '../src/participant-capability.js';

describe('participant capability', () => {
  test('derives the public browser id from the full private capability', () => {
    const capability = 'ab'.repeat(32);
    const samePrefixDifferentSecret = `${'ab'.repeat(16)}${'cd'.repeat(16)}`;
    const participantId = participantIdForCapability(capability);
    assert.equal(normalizeParticipantCapability(capability), capability);
    assert.match(participantId ?? '', /^participant-[0-9a-f]{32}$/);
    assert.notEqual(participantIdForCapability(samePrefixDifferentSecret), participantId);
    assert.equal(browserParticipantIdentity(participantId ?? ''), true);
    assert.equal(participantCapabilityMatches(participantId ?? '', capability), true);
    assert.equal(participantCapabilityMatches(participantId ?? '', samePrefixDifferentSecret), false);
    assert.equal(participantCapabilityMatches(participantId ?? '', null), false);
  });

  test('legacy fixture ids are test-only and production fails closed', () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousLegacyGate = process.env.RELAY_TEST_LEGACY_PARTICIPANTS;
    try {
      assert.equal(browserParticipantIdentity('participant-alice'), false);

      process.env.NODE_ENV = 'production';
      process.env.RELAY_TEST_LEGACY_PARTICIPANTS = '1';
      assert.equal(participantCapabilityMatches('participant-alice', null), false);

      process.env.NODE_ENV = 'test';
      delete process.env.RELAY_TEST_LEGACY_PARTICIPANTS;
      assert.equal(participantCapabilityMatches('participant-alice', null), false);

      process.env.RELAY_TEST_LEGACY_PARTICIPANTS = '1';
      assert.equal(participantCapabilityMatches('participant-alice', null), true);
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousLegacyGate === undefined) delete process.env.RELAY_TEST_LEGACY_PARTICIPANTS;
      else process.env.RELAY_TEST_LEGACY_PARTICIPANTS = previousLegacyGate;
    }
  });

  test('rejects malformed participant capabilities for browser ids', () => {
    const participantId = `participant-${'ab'.repeat(16)}`;
    assert.equal(normalizeParticipantCapability('AB'.repeat(32)), null);
    assert.equal(normalizeParticipantCapability('ab'.repeat(31)), null);
    assert.equal(normalizeParticipantCapability('not-a-secret'), null);
    assert.equal(participantCapabilityMatches(participantId, 'not-a-secret'), false);
  });

  test('human browser sockets carry the private capability with the public identity', () => {
    for (const path of [
      'public/presence.js',
      'public/app.js',
      'public/listen.js',
      'public/live-status.js',
      'public/system-details.js',
      'public/recorder.js',
      'public/youtube-sync.js',
    ]) {
      const source = readFileSync(path, 'utf8');
      assert.match(source, /relayParticipantCapability/);
      assert.match(source, /relayIdentityReady/);
      assert.match(source, /params\.set\('cap',/);
    }

    const server = readFileSync('src/server.ts', 'utf8');
    assert.match(server, /participantCapabilityMatches\(/);
    assert.match(server, /participant-auth-rejected/);
  });
});
