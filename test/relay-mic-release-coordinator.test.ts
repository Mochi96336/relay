import assert from 'node:assert/strict';
import test from 'node:test';

import { createRelayMicReleaseCoordinator } from '../src/relay-mic-release-coordinator.js';

test('publisher release cancels grace and cleans transport before timing invalidation', () => {
  const events: string[] = [];
  const socket = {};
  const coordinator = createRelayMicReleaseCoordinator<typeof socket, { changed: boolean }>({
    publisherParticipantId: () => 'alice',
    mediaOwnerId: () => 'alice',
    revokePublisherTransport: (message) => events.push(`revoke:${message}`),
    clearMediaAuthority: () => events.push('clear-media'),
    cancelTransportGrace: () => events.push('cancel-grace'),
    applyOwnershipEffects: (_effects, hooks) => {
      events.push('apply-effects');
      events.push('quality-event');
      hooks.afterQualityEvent();
      hooks.beforeTimingInvalidation();
      events.push('timing-invalidated');
    },
    broadcastSessionStatus: () => events.push('session-status'),
    sendReleased: (releasedSocket) => {
      assert.equal(releasedSocket, socket);
      events.push('released-ack');
    },
  });

  coordinator.release({ socket, participantId: 'alice', effects: { changed: true } });

  assert.deepEqual(events, [
    'apply-effects',
    'quality-event',
    'cancel-grace',
    'revoke:You released the microphone.',
    'timing-invalidated',
    'session-status',
    'released-ack',
  ]);
});

test('media-only release clears media authority instead of revoking another publisher', () => {
  const events: string[] = [];
  const coordinator = createRelayMicReleaseCoordinator<object, null>({
    publisherParticipantId: () => 'bob',
    mediaOwnerId: () => 'alice',
    revokePublisherTransport: () => events.push('revoke'),
    clearMediaAuthority: () => events.push('clear-media'),
    cancelTransportGrace: () => events.push('cancel-grace'),
    applyOwnershipEffects: (_effects, hooks) => {
      hooks.afterQualityEvent();
      hooks.beforeTimingInvalidation();
    },
    broadcastSessionStatus: () => events.push('session-status'),
    sendReleased: () => events.push('released-ack'),
  });

  coordinator.release({ socket: {}, participantId: 'alice', effects: null });

  assert.deepEqual(events, [
    'cancel-grace',
    'clear-media',
    'session-status',
    'released-ack',
  ]);
});

test('successful release still cleans transport when ownership effects omit timing invalidation', () => {
  const events: string[] = [];
  const coordinator = createRelayMicReleaseCoordinator<object, null>({
    publisherParticipantId: () => 'alice',
    mediaOwnerId: () => 'alice',
    revokePublisherTransport: () => events.push('revoke'),
    clearMediaAuthority: () => events.push('clear-media'),
    cancelTransportGrace: () => events.push('cancel-grace'),
    applyOwnershipEffects: (_effects, hooks) => {
      hooks.afterQualityEvent();
    },
    broadcastSessionStatus: () => events.push('session-status'),
    sendReleased: () => events.push('released-ack'),
  });

  coordinator.release({ socket: {}, participantId: 'alice', effects: null });

  assert.deepEqual(events, [
    'cancel-grace',
    'revoke',
    'session-status',
    'released-ack',
  ]);
});

test('transport cleanup is idempotent when the domain hook is invoked more than once', () => {
  let revocations = 0;
  const coordinator = createRelayMicReleaseCoordinator<object, null>({
    publisherParticipantId: () => 'alice',
    mediaOwnerId: () => 'alice',
    revokePublisherTransport: () => { revocations += 1; },
    clearMediaAuthority: () => assert.fail('publisher path must not clear media separately'),
    cancelTransportGrace: () => {},
    applyOwnershipEffects: (_effects, hooks) => {
      hooks.beforeTimingInvalidation();
      hooks.beforeTimingInvalidation();
    },
    broadcastSessionStatus: () => {},
    sendReleased: () => {},
  });

  coordinator.release({ socket: {}, participantId: 'alice', effects: null });
  assert.equal(revocations, 1);
});
