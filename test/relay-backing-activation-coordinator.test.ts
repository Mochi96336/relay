import assert from 'node:assert/strict';
import test from 'node:test';

import { createRelayBackingActivationCoordinator } from '../src/relay-backing-activation-coordinator.js';

function coordinatorFixture(options: {
  previous: string | null;
  active?: boolean;
  activeRobot?: boolean;
}) {
  const events: string[] = [];
  const coordinator = createRelayBackingActivationCoordinator<string>({
    previousBacking: () => {
      events.push(`previous:${options.previous ?? 'none'}`);
      return options.previous;
    },
    clearRobotBackingBoundaryRequest: () => events.push('clear-boundary'),
    noteQualityEvent: (event) => events.push(`quality:${event}`),
    retirePrevious: (previous, next) => events.push(`retire:${previous ?? 'none'}->${next}`),
    setSocketSampleRate: (socket, sampleRate) => events.push(`sample-rate:${socket}:${sampleRate}`),
    bindBacking: ({ socket, sampleRate, robot }) => {
      events.push(`bind:${socket}:${sampleRate}:${robot}`);
    },
    setBackingExpected: () => events.push('expected'),
    sessionActive: () => {
      events.push(`session-active:${options.active ?? true}`);
      return options.active ?? true;
    },
    dropLegacyCalibrationForRobot: () => events.push('drop-legacy-calibration'),
    activeBackingIsRobot: () => {
      events.push(`active-robot:${options.activeRobot ?? false}`);
      return options.activeRobot ?? false;
    },
    sendRegistered: (socket, robot) => events.push(`registered:${socket}:${robot}`),
    startLiveSource: () => events.push('start-live-source'),
  });
  return { coordinator, events };
}

test('replacement activation preserves replacement quality and retirement before binding', () => {
  const { coordinator, events } = coordinatorFixture({
    previous: 'old',
    active: true,
    activeRobot: true,
  });

  coordinator.activate({ socket: 'new', sampleRate: 48_000, robot: true });

  assert.deepEqual(events, [
    'previous:old',
    'clear-boundary',
    'quality:backing-transport-replaced',
    'retire:old->new',
    'sample-rate:new:48000',
    'bind:new:48000:true',
    'expected',
    'drop-legacy-calibration',
    'active-robot:true',
    'registered:new:true',
    'start-live-source',
  ]);
});

test('first Backing transport records connection quality only after bind/expected state', () => {
  const { coordinator, events } = coordinatorFixture({
    previous: null,
    active: true,
    activeRobot: false,
  });

  coordinator.activate({ socket: 'new', sampleRate: 44_100, robot: false });

  assert.deepEqual(events, [
    'previous:none',
    'clear-boundary',
    'retire:none->new',
    'sample-rate:new:44100',
    'bind:new:44100:false',
    'expected',
    'session-active:true',
    'quality:backing-transport-connected',
    'drop-legacy-calibration',
    'active-robot:false',
    'registered:new:false',
    'start-live-source',
  ]);
});

test('re-registering the same active socket is neither replacement nor first connection', () => {
  const { coordinator, events } = coordinatorFixture({
    previous: 'same',
    active: true,
    activeRobot: false,
  });

  coordinator.activate({ socket: 'same', sampleRate: 48_000, robot: false });

  assert.equal(events.some((event) => event.startsWith('quality:')), false);
  assert.deepEqual(events.slice(0, 6), [
    'previous:same',
    'clear-boundary',
    'retire:same->same',
    'sample-rate:same:48000',
    'bind:same:48000:false',
    'expected',
  ]);
});
