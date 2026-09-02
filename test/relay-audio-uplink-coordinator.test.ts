import assert from 'node:assert/strict';
import test from 'node:test';

import { createRelayAudioUplinkCoordinator } from '../src/relay-audio-uplink-coordinator.js';
import type { PcmFrame } from '../src/pcm-frame.js';

type Socket = { id: string };

const frame: PcmFrame = {
  generation: 7,
  firstSampleIndex: 120,
  pcm: Buffer.from([1, 2, 3, 4]),
};

function harness(input: {
  mic?: boolean;
  backing?: boolean;
  previousGeneration?: number | null;
  nextGeneration?: number | null;
  mappedStart?: number | null;
} = {}) {
  const events: string[] = [];
  let generation = input.previousGeneration === undefined ? 3 : input.previousGeneration;
  const samples = new Int16Array([1000, -1000]);
  const coordinator = createRelayAudioUplinkCoordinator<Socket>({
    isMicPublisher: () => {
      events.push('is-mic');
      return input.mic === true;
    },
    receiveMic: (_socket, data, nowMs) => {
      assert.equal(data.toString('hex'), 'aabb');
      assert.equal(nowMs, 42);
      events.push('receive-mic');
    },
    isBackingActive: () => {
      events.push('is-backing');
      return input.backing === true;
    },
    decodeBacking: (data) => {
      assert.equal(data.toString('hex'), 'aabb');
      events.push('decode');
      return frame;
    },
    backingGeneration: () => {
      events.push(`generation:${generation ?? 'null'}`);
      return generation;
    },
    now: () => {
      events.push('now');
      return 42;
    },
    noteBackingFrame: () => events.push('note-frame'),
    ingestBacking: (receivedFrame, nowMs) => {
      assert.equal(receivedFrame, frame);
      assert.equal(nowMs, 42);
      events.push('ingest');
      generation = input.nextGeneration ?? generation;
      return { samples, start: 900 };
    },
    onBackingCaptureRestarted: () => events.push('restart'),
    noteRobotTransitionBackingFrame: (receivedFrame, receivedSamples, start, nowMs) => {
      assert.equal(receivedFrame, frame);
      assert.equal(receivedSamples, samples);
      assert.equal(start, 900);
      assert.equal(nowMs, 42);
      events.push('robot-transition');
    },
    mappedContentBackingStart: (start, nowMs) => {
      assert.equal(start, 900);
      assert.equal(nowMs, 42);
      events.push('map-content');
      return input.mappedStart === undefined ? 1234 : input.mappedStart;
    },
    feedContentBackingEvidence: (receivedSamples, start, nowMs) => {
      assert.equal(receivedSamples, samples);
      assert.equal(start, 1234);
      assert.equal(nowMs, 42);
      events.push('feed-content');
    },
  });
  return { coordinator, events };
}

test('unrelated binary socket is ignored without requesting time', () => {
  const { coordinator, events } = harness();
  assert.equal(coordinator.handle({ id: 'other' }, Buffer.from([0xaa, 0xbb])), null);
  assert.deepEqual(events, ['is-mic', 'is-backing']);
});

test('Mic uplink wins and never enters Backing handling', () => {
  const { coordinator, events } = harness({ mic: true, backing: true });
  assert.equal(coordinator.handle({ id: 'mic' }, Buffer.from([0xaa, 0xbb])), 'mic');
  assert.deepEqual(events, ['is-mic', 'now', 'receive-mic']);
});

test('Backing uplink preserves ingest, restart, transition and content-evidence order', () => {
  const { coordinator, events } = harness({
    backing: true,
    previousGeneration: 3,
    nextGeneration: 4,
  });
  assert.equal(coordinator.handle({ id: 'backing' }, Buffer.from([0xaa, 0xbb])), 'backing');
  assert.deepEqual(events, [
    'is-mic',
    'is-backing',
    'decode',
    'generation:3',
    'now',
    'note-frame',
    'ingest',
    'generation:4',
    'restart',
    'robot-transition',
    'map-content',
    'feed-content',
  ]);
});

test('first Backing generation does not report a capture restart', () => {
  const { coordinator, events } = harness({
    backing: true,
    previousGeneration: null,
    nextGeneration: 4,
  });
  coordinator.handle({ id: 'backing' }, Buffer.from([0xaa, 0xbb]));
  assert.equal(events.includes('restart'), false);
});

test('unmapped Backing content skips content evidence', () => {
  const { coordinator, events } = harness({ backing: true, mappedStart: null });
  coordinator.handle({ id: 'backing' }, Buffer.from([0xaa, 0xbb]));
  assert.equal(events.includes('feed-content'), false);
  assert.equal(events.at(-1), 'map-content');
});
