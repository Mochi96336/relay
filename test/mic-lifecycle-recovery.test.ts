import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const presence = readFileSync(new URL('../public/presence.js', import.meta.url), 'utf8');
const listen = readFileSync(new URL('../public/listen.js', import.meta.url), 'utf8');

test('local Mic capture publishes an explicit lifecycle independent of server presence', () => {
  assert.match(app, /function setPublisherActive\(active\)[\s\S]*relayActiveRole = publisherActive \? 'publisher' : null/);
  assert.match(app, /releaseButton\.hidden = !publisherActive/);
  assert.match(app, /dispatchRelayEvent\('relay-microphone-local-state', \{ active: publisherActive \}\)/);

  assert.match(presence, /let localPublisherActive = window\.relayActiveRole === 'publisher'/);
  assert.match(presence, /releaseButton\.hidden = !serverOwnsMic && !localPublisherActive/);
  assert.match(presence, /relay-microphone-local-state/);
});

test('Release tears down local capture even if the Presence websocket cannot send', () => {
  const releaseStart = presence.indexOf("releaseButton.addEventListener('click'");
  const renameStart = presence.indexOf('function beginRename', releaseStart);
  assert.ok(releaseStart >= 0 && renameStart > releaseStart);
  const releaseHandler = presence.slice(releaseStart, renameStart);

  assert.match(releaseHandler, /send\(\{ type: 'release-mic' \}\)/,
    'Presence should still use its healthy control socket when available');
  assert.match(releaseHandler, /relay-release-microphone/,
    'local teardown must not depend on the Presence send succeeding');

  const appReleaseStart = app.indexOf("window.addEventListener('relay-release-microphone'");
  const slidersStart = app.indexOf('for (const slider', appReleaseStart);
  assert.ok(appReleaseStart >= 0 && slidersStart > appReleaseStart);
  const appRelease = app.slice(appReleaseStart, slidersStart);
  assert.match(appRelease, /stop\(false, \{ releaseMic: true \}\)/);
  assert.match(appRelease, /relay-microphone-ended/);
});

test('failed Mic ownership attempts end the independent Listen mute lifecycle', () => {
  for (const event of ['relay-mic-busy', 'relay-mic-takeover-rejected']) {
    assert.match(listen, new RegExp(`window\\.addEventListener\\('${event}'[\\s\\S]*restoreAfterMic`));
  }

  const busyStart = app.indexOf("if (message.type === 'mic-busy')");
  const takeoverStart = app.indexOf("if (message.type === 'mic-takeover-rejected')", busyStart);
  const revokedStart = app.indexOf("if (message.type === 'mic-revoked')", takeoverStart);
  assert.ok(busyStart >= 0 && takeoverStart > busyStart && revokedStart > takeoverStart);
  assert.match(app.slice(busyStart, takeoverStart), /relay-microphone-ended'[\s\S]*reason: 'busy'/);
  assert.match(app.slice(takeoverStart, revokedStart), /relay-microphone-ended'[\s\S]*reason: 'takeover-rejected'/);
});

test('hardware input ending completes the same Mic lifecycle', () => {
  const trackStart = app.indexOf("track?.addEventListener('ended'");
  const graphStart = app.indexOf('const source = audioContext.createMediaStreamSource', trackStart);
  assert.ok(trackStart >= 0 && graphStart > trackStart);
  const handler = app.slice(trackStart, graphStart);
  assert.match(handler, /stop\(false, \{ releaseMic: true \}\)/);
  assert.match(handler, /relay-microphone-ended'[\s\S]*reason: 'input-ended'/);
});

test('initial Relay connection failure remains cancellable instead of trapping an active Mic', () => {
  const activeAt = app.indexOf('setPublisherActive(true)');
  const disabledAt = app.indexOf('publisherButton.disabled = true', activeAt);
  const connectAt = app.indexOf('await connectPublisherSocket()', disabledAt);
  const retryAt = app.indexOf('schedulePublisherReconnect()', connectAt);
  assert.ok(activeAt >= 0 && disabledAt > activeAt && connectAt > disabledAt && retryAt > connectAt);

  // setPublisherActive(true) makes Release visible before the first control
  // connection succeeds, so the retry loop can always be cancelled locally.
  assert.match(app, /releaseButton\.hidden = !publisherActive/);
});
