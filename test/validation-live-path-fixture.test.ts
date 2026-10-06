import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { functionCode, parseTypeScriptSource } from './support/source-contract.js';

const source = parseTypeScriptSource(
  new URL('./content-calibration-validation-server.test.ts', import.meta.url),
  readFileSync(new URL('./content-calibration-validation-server.test.ts', import.meta.url), 'utf8'),
);
function body(name: string) {
  const code = functionCode(source, name);
  return code.slice(code.indexOf('{'), code.lastIndexOf('}') + 1);
}
type Message = { type: string; outcome?: string };

// Execute the actual fixture bodies without importing a .test.ts and starting
// another server suite. Only the wait result and interval scheduler are controlled.
function fixture(messages: Message[] = []) {
  const monitor = { messages };
  const sends: Array<{ kind: string; payload: unknown }> = [];
  const backing = { sendPcm: (payload: Buffer) => sends.push({ kind: 'backing-pcm', payload }) };
  const publisher = {
    send: (payload: Message) => sends.push({ kind: 'publisher-message', payload }),
    sendPcm: (payload: Buffer) => sends.push({ kind: 'publisher-pcm', payload }),
  };
  const telemetry = { type: 'youtube-telemetry' };
  const refresh = new Function('playingTelemetry', `return function(backing, publisher) ${body('refreshLivePath')}`)(
    () => telemetry,
  );
  let active = false, callback: (() => void) | undefined, intervalMs: number | undefined;
  const timer = Symbol('fixture-interval');
  const cleared: unknown[] = [];
  let resolve!: (value: Message) => void;
  let reject!: (error: Error) => void;
  const answer = new Promise<Message>((yes, no) => { resolve = yes; reject = no; });
  const waitCalls: unknown[][] = [];
  const wait = (...args: unknown[]) => { waitCalls.push(args); return answer; };
  const start = (tick: () => void, ms: number) => {
    assert.equal(active, false); callback = tick; intervalMs = ms; active = true; return timer;
  };
  const stop = (id: unknown) => { assert.equal(id, timer); cleared.push(id); active = false; };
  const predicate = (message: Message) => message.type === 'timing-calibration-status'
    && message.outcome === 'wanted';
  const outcome = new Function('setInterval', 'clearInterval', 'refreshLivePath', 'waitForNewMessage',
    `return async function(monitor, fromIndex, backing, publisher, predicate, timeoutMs) ${body('waitForValidationOutcome')}`)(
    start, stop, refresh, wait,
  );
  const running: Promise<Message> = outcome(monitor, 1, backing, publisher, predicate, 4_000);
  return { monitor, backing, publisher, telemetry, sends, timer, cleared, waitCalls, predicate,
    running, resolve, reject, intervalMs, active: () => active,
    tick: () => { if (active) callback!(); } };
}

test('actual liveness helper sends real PCM and telemetry at 100ms, without a status request', async () => {
  const h = fixture();
  assert.equal(h.intervalMs, 100); assert.equal(h.sends.length, 0);
  h.tick();
  assert.deepEqual(h.sends.map(send => send.kind), ['publisher-message', 'backing-pcm', 'publisher-pcm']);
  assert.equal(h.sends[0].payload, h.telemetry);
  assert.ok(Buffer.isBuffer(h.sends[1].payload));
  assert.equal((h.sends[1].payload as Buffer).byteLength, 960 * 2);
  assert.equal(h.sends[2].payload, h.sends[1].payload);
  h.resolve({ type: 'done' }); await h.running;
});

test('a stale outcome before fromIndex cannot suppress current capture flow', async () => {
  const h = fixture([{ type: 'timing-calibration-status', outcome: 'wanted' }]);
  h.tick(); assert.equal(h.sends.length, 3);
  h.resolve({ type: 'done' }); await h.running;
});

test('a matching new outcome stops PCM even before the waiter resolves', async () => {
  const h = fixture([{ type: 'old' }]);
  h.tick();
  h.monitor.messages.push({ type: 'timing-calibration-status', outcome: 'wanted' });
  h.tick(); h.tick(); assert.equal(h.sends.length, 3);
  h.resolve({ type: 'done' }); await h.running;
});

test('an unrelated new event does not stand down the admitted live fixture', async () => {
  const h = fixture([{ type: 'old' }, { type: 'source-status', outcome: 'wanted' }]);
  h.tick(); assert.equal(h.sends.length, 3);
  h.resolve({ type: 'done' }); await h.running;
});

test('resolution keeps all waiter arguments and return identity, and clears the exact timer once', async () => {
  const h = fixture();
  assert.deepEqual(h.waitCalls, [[h.monitor, 1, h.predicate, 4_000]]);
  const result = { type: 'timing-calibration-status', outcome: 'wanted' };
  h.resolve(result); assert.equal(await h.running, result);
  assert.equal(h.active(), false); assert.deepEqual(h.cleared, [h.timer]);
  h.tick(); assert.equal(h.sends.length, 0);
});

test('rejection preserves the original error and clears the timer before subsequent work', async () => {
  const h = fixture(); h.tick();
  const error = new Error('original wait timeout');
  const rejected = assert.rejects(h.running, value => value === error);
  h.reject(error); await rejected;
  assert.equal(h.active(), false); assert.deepEqual(h.cleared, [h.timer]);
  h.tick(); assert.equal(h.sends.length, 3);
});
