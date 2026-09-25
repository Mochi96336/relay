import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { createReconnectBackoff } from '../public/reconnect-backoff.js';

describe('publisher reconnect backoff', () => {
  it('retries a dropped socket almost at once, then backs off while it keeps failing', () => {
    const backoff = createReconnectBackoff();
    assert.deepEqual(
      [backoff.nextDelayMs(), backoff.nextDelayMs(), backoff.nextDelayMs(), backoff.nextDelayMs()],
      [100, 400, 1000, 1000],
    );
  });

  it('starts over only after a connection actually stayed up', () => {
    const backoff = createReconnectBackoff({ delaysMs: [100, 400, 1000], stableAfterMs: 5_000 });
    backoff.nextDelayMs();
    backoff.nextDelayMs();

    // A server that accepts and then drops at once is not a recovery.
    backoff.noteConnected(1_000);
    backoff.noteClosed(1_200);
    assert.equal(backoff.nextDelayMs(), 1000);

    backoff.noteConnected(2_000);
    backoff.noteClosed(9_000);
    assert.equal(backoff.nextDelayMs(), 100, 'a stable connection earns a fast first retry again');
  });

  it('starts over for a new capture', () => {
    const backoff = createReconnectBackoff();
    backoff.nextDelayMs();
    backoff.nextDelayMs();
    backoff.reset();
    assert.equal(backoff.nextDelayMs(), 100);
  });

  it('rejects a schedule it cannot follow', () => {
    assert.throws(() => createReconnectBackoff({ delaysMs: [] }), /non-empty/);
    assert.throws(() => createReconnectBackoff({ delaysMs: [-1] }), /non-negative/);
  });

  it('drives the publisher control socket reconnect in the page', () => {
    const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
    const schedule = app.slice(
      app.indexOf('function schedulePublisherReconnect'),
      app.indexOf('function adoptSocket'),
    );
    assert.match(schedule, /publisherReconnectBackoff\.nextDelayMs\(\)/);
    assert.doesNotMatch(app, /SOCKET_RECONNECT_MS/, 'no fixed one-second wait remains');
    assert.match(app, /adoptSocket\(ws\);\s*publisherReconnectBackoff\.noteConnected\(/);
    assert.match(app, /if \(socket !== ws\) return;\s*publisherReconnectBackoff\.noteClosed\(/);
  });
});
