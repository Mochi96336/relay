import assert from 'node:assert/strict';
import test from 'node:test';

import { MicPathDifferenceMemory } from '../src/mic-path-difference-memory.js';

test('a device it never measured gets the room-wide default', () => {
  const memory = new MicPathDifferenceMemory({ defaultMs: 40 });
  assert.deepEqual(memory.priorFor('participant-a', 'iPhone Microphone'), { pathDifferenceMs: 40, measurements: 0 });
  assert.deepEqual(memory.priorFor(null, null), { pathDifferenceMs: 40, measurements: 0 });
});

test('a device answers with the median of its own last measurements, so one bad probe does not stick', () => {
  const memory = new MicPathDifferenceMemory({ defaultMs: 40, measurementsPerDevice: 5 });
  for (const value of [25, 30, 2045, 20, 25]) memory.remember('participant-a', 'iPhone Microphone', value);
  assert.deepEqual(memory.priorFor('participant-a', 'iPhone Microphone'), { pathDifferenceMs: 25, measurements: 5 });

  // Only the last five count: the outlier ages out.
  memory.remember('participant-a', 'iPhone Microphone', 35);
  memory.remember('participant-a', 'iPhone Microphone', 30);
  memory.remember('participant-a', 'iPhone Microphone', 30);
  assert.equal(memory.priorFor('participant-a', 'iPhone Microphone').pathDifferenceMs, 30);

  const even = new MicPathDifferenceMemory({ defaultMs: 40 });
  even.remember('participant-b', null, 10);
  even.remember('participant-b', null, 20);
  assert.equal(even.priorFor('participant-b', null).pathDifferenceMs, 15);
});

test('the same participant with another input is another device', () => {
  const memory = new MicPathDifferenceMemory({ defaultMs: 40 });
  memory.remember('participant-a', 'iPhone Microphone', 25);
  memory.remember('participant-a', 'Headset (Philips Fidelio L3)', 300);
  assert.equal(memory.priorFor('participant-a', 'iPhone Microphone').pathDifferenceMs, 25);
  assert.equal(memory.priorFor('participant-a', 'Headset (Philips Fidelio L3)').pathDifferenceMs, 300);
  assert.equal(memory.priorFor('participant-b', 'iPhone Microphone').measurements, 0);
});

test('non-finite measurements are ignored and the oldest device is forgotten past the bound', () => {
  const memory = new MicPathDifferenceMemory({ defaultMs: 40, maxDevices: 2 });
  memory.remember('participant-a', null, Number.NaN);
  assert.equal(memory.priorFor('participant-a', null).measurements, 0);

  memory.remember('participant-a', null, 10);
  memory.remember('participant-b', null, 20);
  memory.remember('participant-a', null, 12);
  memory.remember('participant-c', null, 30);
  assert.equal(memory.priorFor('participant-b', null).measurements, 0, 'least recently measured goes first');
  assert.equal(memory.priorFor('participant-a', null).measurements, 2);
  assert.equal(memory.priorFor('participant-c', null).measurements, 1);
});
