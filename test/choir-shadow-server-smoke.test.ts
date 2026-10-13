import assert from 'node:assert/strict';
import test from 'node:test';
import { startRelay } from './helpers/harness.js';

/**
 * Real production entrypoint smoke: opt-in Choir observes only.
 * No Mic admission, new client message, PCM routing or monitoring output
 * is enabled by this flag.
 */
test('flagged Choir control-plane shadow starts and shuts down ordinary Relay cleanly', async () => {
  const relay = await startRelay({ RELAY_CHOIR_SHADOW: '1' });
  try {
    const response = await fetch(relay.httpUrl('/'));
    assert.equal(response.status, 200);
    const page = await response.text();
    assert.ok(page.length > 0);
  } finally {
    await relay.stop();
  }
});
