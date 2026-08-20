import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('failed Mic startup cleans up before releasing Listen AudioSession ownership', () => {
  const requestStart = app.indexOf('async function requestPublisherStart');
  const listenerStart = app.indexOf("window.addEventListener('relay-product-status'", requestStart);
  assert.ok(requestStart >= 0 && listenerStart > requestStart);
  const request = app.slice(requestStart, listenerStart);

  const failureStart = request.indexOf("if (error?.code === 'mic-startup-cancelled') return;");
  assert.ok(failureStart >= 0);
  const failure = request.slice(failureStart);
  const cleanupAt = failure.indexOf("await stop(false, { releaseMic: false });");
  const terminalAt = failure.indexOf("dispatchRelayEvent('relay-microphone-start-failed'");

  assert.ok(cleanupAt >= 0 && terminalAt > cleanupAt,
    'start-failed must be emitted only after tracks/context cleanup so a queued retry cannot strand play-and-record or local forced mute');
});
