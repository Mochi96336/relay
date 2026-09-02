import assert from 'node:assert/strict';
import test from 'node:test';

import { createRelayPublisherActivationCoordinator } from '../src/relay-publisher-activation-coordinator.js';

type Socket = { id: string; participantId: string | null };
type OwnershipEffects = { id: string };

function harness(input: {
  participantId?: string | null;
  previousPublisher?: Socket | null;
  sameParticipantReplacement?: boolean;
  sameCapture?: boolean;
  sessionActive?: boolean;
  deferredTimingReason?: string | null;
  deferredHandoffParticipantId?: string | null;
  mediaTransport?: unknown;
} = {}) {
  const events: string[] = [];
  const socket: Socket = {
    id: 'next',
    participantId: input.participantId === undefined ? 'participant-bob' : input.participantId,
  };
  const previousPublisher = input.previousPublisher === undefined
    ? { id: 'previous', participantId: 'participant-alice' }
    : input.previousPublisher;
  let registered: { takeover: boolean; mediaTransport: unknown } | null = null;

  const coordinator = createRelayPublisherActivationCoordinator<Socket, OwnershipEffects>({
    now: () => {
      events.push('now');
      return 42;
    },
    participantId: (target) => target.participantId,
    applyOwnershipEffects: (_effects, hooks) => {
      events.push('ownership-effects');
      if (input.deferredTimingReason) hooks.invalidateTiming(input.deferredTimingReason);
      if (input.deferredHandoffParticipantId) {
        hooks.prepareSongHandoff(input.deferredHandoffParticipantId);
      }
    },
    bindPublisher: (registration) => {
      assert.equal(registration.socket, socket);
      assert.equal(registration.sampleRate, 48_000);
      assert.equal(registration.captureGeneration, 7);
      assert.equal(registration.initialSequence, 11);
      assert.equal(registration.audioPacketVersion, 2);
      assert.equal(registration.nowMs, 42);
      events.push('bind');
      return {
        previousPublisher,
        sameParticipantReplacement: input.sameParticipantReplacement === true,
        sameCapture: input.sameCapture === true,
      };
    },
    retirePrevious: (previous, next, sameParticipantReplacement) => {
      assert.equal(previous, previousPublisher);
      assert.equal(next, socket);
      events.push(`retire:${sameParticipantReplacement ? 'superseded' : 'revoked'}`);
    },
    cancelTransportGrace: () => events.push('cancel-grace'),
    setMicExpected: () => events.push('mic-expected'),
    sessionActive: () => input.sessionActive === true,
    noteTransportConnected: () => events.push('transport-connected'),
    invalidateTiming: (reason) => events.push(`invalidate:${reason}`),
    restartLiveSource: () => events.push('restart-live'),
    directMediaOffer: () => {
      events.push('media-offer');
      return input.mediaTransport;
    },
    sendRegistered: (_socket, result) => {
      registered = result;
      events.push('registered');
    },
    sendInitialState: () => events.push('initial-state'),
    broadcastStatus: () => events.push('status'),
    broadcastSessionStatus: () => events.push('session-status'),
    beginPreparedSongHandoff: (participantId) => events.push(`handoff:${participantId}`),
  });

  return { coordinator, events, socket, getRegistered: () => registered };
}

function request(socket: Socket, ownershipEffects: OwnershipEffects | null = null) {
  return {
    socket,
    ownershipEffects,
    previousOwnerId: 'participant-alice',
    takeoverRequested: true,
    sampleRate: 48_000,
    captureGeneration: 7,
    initialSequence: 11,
    audioPacketVersion: 2 as const,
  };
}

test('confirmed cross-participant takeover preserves effect, bind, retirement and handoff order', () => {
  const { coordinator, events, socket, getRegistered } = harness({
    deferredTimingReason: 'Microphone owner changed.',
    deferredHandoffParticipantId: 'participant-bob',
    mediaTransport: { kind: 'webtransport' },
  });

  coordinator.activate(request(socket, { id: 'effects' }));

  assert.deepEqual(events, [
    'ownership-effects',
    'now',
    'bind',
    'retire:revoked',
    'cancel-grace',
    'mic-expected',
    'invalidate:Microphone owner changed.',
    'restart-live',
    'media-offer',
    'registered',
    'initial-state',
    'status',
    'session-status',
    'handoff:participant-bob',
  ]);
  assert.deepEqual(getRegistered(), {
    takeover: true,
    mediaTransport: { kind: 'webtransport' },
  });
});

test('same-participant replacement invalidates changed capture after bind', () => {
  const previous = { id: 'old', participantId: 'participant-bob' };
  const { coordinator, events, socket, getRegistered } = harness({
    previousPublisher: previous,
    sameParticipantReplacement: true,
    sameCapture: false,
  });

  coordinator.activate({
    ...request(socket),
    ownershipEffects: null,
    previousOwnerId: 'participant-bob',
    takeoverRequested: false,
  });

  assert.ok(events.indexOf('bind') < events.indexOf('retire:superseded'));
  assert.ok(events.indexOf('retire:superseded') < events.indexOf('invalidate:Microphone capture changed.'));
  assert.equal(events.includes('ownership-effects'), false);
  assert.equal(getRegistered()?.takeover, false);
});

test('same capture replacement does not invalidate timing', () => {
  const previous = { id: 'old', participantId: 'participant-bob' };
  const { coordinator, events, socket } = harness({
    previousPublisher: previous,
    sameParticipantReplacement: true,
    sameCapture: true,
  });

  coordinator.activate({
    ...request(socket),
    ownershipEffects: null,
    previousOwnerId: 'participant-bob',
    takeoverRequested: false,
  });

  assert.equal(events.some((event) => event.startsWith('invalidate:')), false);
});

test('first publisher during an active session records transport connection', () => {
  const { coordinator, events, socket } = harness({
    previousPublisher: null,
    sessionActive: true,
  });

  coordinator.activate({
    ...request(socket),
    ownershipEffects: null,
    takeoverRequested: false,
    previousOwnerId: null,
  });

  assert.ok(events.indexOf('mic-expected') < events.indexOf('transport-connected'));
  assert.ok(events.indexOf('transport-connected') < events.indexOf('restart-live'));
});

test('legacy anonymous publisher skips participant status and handoff', () => {
  const { coordinator, events, socket } = harness({
    participantId: null,
    previousPublisher: null,
    deferredHandoffParticipantId: 'participant-never',
  });

  coordinator.activate(request(socket, { id: 'effects' }));

  assert.equal(events.includes('session-status'), false);
  assert.equal(events.some((event) => event.startsWith('handoff:')), false);
});
