import assert from 'node:assert/strict';
import test from 'node:test';

import { MicTransportGraceRuntime } from '../src/mic-transport-grace-runtime.js';

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

test('MicTransportGraceRuntime rejects invalid grace durations', () => {
  assert.throws(
    () => new MicTransportGraceRuntime({ graceMs: 0, onExpired: () => {} }),
    /graceMs must be positive/,
  );
});

test('schedule owns the pending owner and expiration clears state before callback', async () => {
  let runtime!: MicTransportGraceRuntime;
  const expired: string[] = [];
  runtime = new MicTransportGraceRuntime({
    graceMs: 10,
    onExpired: (ownerId) => {
      assert.equal(runtime.pending, false);
      assert.equal(runtime.ownerId, null);
      expired.push(ownerId);
    },
  });

  runtime.schedule('participant-a');
  assert.equal(runtime.pending, true);
  assert.equal(runtime.ownerId, 'participant-a');

  await sleep(30);
  assert.deepEqual(expired, ['participant-a']);
  assert.equal(runtime.pending, false);
  assert.equal(runtime.ownerId, null);
});

test('a replacement schedule cancels the older owner and expires only the newest owner', async () => {
  const expired: string[] = [];
  const runtime = new MicTransportGraceRuntime({
    graceMs: 20,
    onExpired: (ownerId) => expired.push(ownerId),
  });

  runtime.schedule('participant-a');
  await sleep(5);
  runtime.schedule('participant-b');

  assert.equal(runtime.ownerId, 'participant-b');
  await sleep(35);
  assert.deepEqual(expired, ['participant-b']);
});

test('cancel clears grace state and prevents the expiration callback', async () => {
  const expired: string[] = [];
  const runtime = new MicTransportGraceRuntime({
    graceMs: 10,
    onExpired: (ownerId) => expired.push(ownerId),
  });

  runtime.schedule('participant-a');
  assert.equal(runtime.cancel(), true);
  assert.equal(runtime.cancel(), false);
  assert.equal(runtime.pending, false);
  assert.equal(runtime.ownerId, null);

  await sleep(25);
  assert.deepEqual(expired, []);
});

test('expiration callback can re-arm grace for the same owner', async () => {
  let expirations = 0;
  let runtime!: MicTransportGraceRuntime;
  runtime = new MicTransportGraceRuntime({
    graceMs: 10,
    onExpired: (ownerId) => {
      expirations += 1;
      if (expirations === 1) runtime.schedule(ownerId);
    },
  });

  runtime.schedule('participant-a');
  await sleep(15);
  assert.equal(expirations, 1);
  assert.equal(runtime.pending, true);
  assert.equal(runtime.ownerId, 'participant-a');

  await sleep(20);
  assert.equal(expirations, 2);
  assert.equal(runtime.pending, false);
});
