import assert from 'node:assert/strict';
import test from 'node:test';

// @ts-expect-error Production browser helpers intentionally ship as plain JS.
import { MicLifecycleTransaction } from '../public/mic-lifecycle-transaction.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('Mic terminal event is not observable until async teardown resolves', async () => {
  const teardown = deferred<number>();
  const transaction = new MicLifecycleTransaction();
  let ended = 0;

  const pending = transaction.run({
    sessionEpoch: 6,
    stop: () => teardown.promise,
    isCurrent: (stoppedEpoch: number) => stoppedEpoch === 7,
    onEnded: () => { ended += 1; },
  });

  await Promise.resolve();
  assert.equal(ended, 0);

  teardown.resolve(7);
  assert.equal(await pending, true);
  assert.equal(ended, 1);
});

test('duplicate terminal signals for one Mic session share one teardown and emit ended once', async () => {
  const teardown = deferred<number>();
  const transaction = new MicLifecycleTransaction();
  let stopCalls = 0;
  let ended = 0;

  const options = {
    sessionEpoch: 10,
    stop: () => {
      stopCalls += 1;
      return teardown.promise;
    },
    isCurrent: (stoppedEpoch: number) => stoppedEpoch === 11,
    onEnded: () => { ended += 1; },
  };

  const first = transaction.run(options);
  const second = transaction.run(options);
  assert.equal(first, second);
  assert.equal(stopCalls, 1);
  assert.equal(ended, 0);

  teardown.resolve(11);
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(ended, 1);
});

test('a replacement Mic session can terminate while the prior teardown is still pending', async () => {
  const priorTeardown = deferred<number>();
  const replacementTeardown = deferred<number>();
  const transaction = new MicLifecycleTransaction();
  let stopCalls = 0;
  const ended: string[] = [];

  const prior = transaction.run({
    sessionEpoch: 20,
    stop: () => {
      stopCalls += 1;
      return priorTeardown.promise;
    },
    isCurrent: () => false,
    onEnded: () => { ended.push('prior'); },
  });
  const replacement = transaction.run({
    sessionEpoch: 22,
    stop: () => {
      stopCalls += 1;
      return replacementTeardown.promise;
    },
    isCurrent: (stoppedEpoch: number) => stoppedEpoch === 23,
    onEnded: () => { ended.push('replacement'); },
  });

  assert.notEqual(prior, replacement);
  assert.equal(stopCalls, 2);

  priorTeardown.resolve(21);
  assert.equal(await prior, false);
  assert.deepEqual(ended, []);

  replacementTeardown.resolve(23);
  assert.equal(await replacement, true);
  assert.deepEqual(ended, ['replacement']);
});

test('stale teardown completion cannot end a replacement Mic session', async () => {
  const transaction = new MicLifecycleTransaction();
  let ended = 0;

  const completed = await transaction.run({
    sessionEpoch: 12,
    stop: async () => 13,
    isCurrent: () => false,
    onEnded: () => { ended += 1; },
  });

  assert.equal(completed, false);
  assert.equal(ended, 0);
});
