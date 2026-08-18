import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const presence = readFileSync(new URL('../public/presence.js', import.meta.url), 'utf8');
const listen = readFileSync(new URL('../public/listen.js', import.meta.url), 'utf8');
const youtubeSync = readFileSync(new URL('../public/youtube-sync.js', import.meta.url), 'utf8');
const actionCss = readFileSync(new URL('../public/action-language.css', import.meta.url), 'utf8');

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

test('failed Mic ownership attempts clean up before Listen is allowed to recover', () => {
  assert.match(
    listen,
    /function restoreAfterMicBoundary\(copy[\s\S]*const restoreEpoch = micMuteEpoch[\s\S]*setTimeout\(\(\) => \{[\s\S]*if \(micMuteEpoch !== restoreEpoch\) return;[\s\S]*restoreAfterMic\(copy\);[\s\S]*\}, 0\)/,
    'a stale terminal restore must not unmute a replacement Mic session',
  );
  assert.match(listen, /window\.addEventListener\('relay-microphone-ended',[\s\S]*restoreAfterMicBoundary/);
  assert.match(listen, /window\.addEventListener\('relay-microphone-start-failed',[\s\S]*restoreAfterMicBoundary/);
  assert.doesNotMatch(listen, /window\.addEventListener\('relay-mic-busy'/);
  assert.doesNotMatch(listen, /window\.addEventListener\('relay-mic-takeover-rejected'/);

  const busyStart = app.indexOf("if (message.type === 'mic-busy')");
  const takeoverStart = app.indexOf("if (message.type === 'mic-takeover-rejected')", busyStart);
  const revokedStart = app.indexOf("if (message.type === 'mic-revoked')", takeoverStart);
  assert.ok(busyStart >= 0 && takeoverStart > busyStart && revokedStart > takeoverStart);

  const busy = app.slice(busyStart, takeoverStart);
  const takeover = app.slice(takeoverStart, revokedStart);
  assert.match(busy, /stop\(false, \{ releaseMic: false \}\)[\s\S]*relay-microphone-ended'[\s\S]*reason: 'busy'/);
  assert.match(takeover, /stop\(false, \{ releaseMic: false \}\)[\s\S]*relay-microphone-ended'[\s\S]*reason: 'takeover-rejected'/);
});

test('room Mic ownership force-mutes Listen in sibling tabs that share the participant identity', () => {
  const publishAt = presence.indexOf('function publishSessionStatus');
  const handleAt = presence.indexOf('function handleMessage', publishAt);
  assert.ok(publishAt >= 0 && handleAt > publishAt);
  const presenceProjection = presence.slice(publishAt, handleAt);
  assert.match(presenceProjection, /relay-session-status/,
    'Presence must project authoritative room ownership to each tab');
  assert.match(presenceProjection, /relay-request-session-status/,
    'late module consumers must be able to replay the current ownership snapshot');

  assert.match(listen, /let roomMicForcedMuted = false/);
  assert.match(
    listen,
    /return userMuted\s*\|\| micForcedMuted\s*\|\| roomMicForcedMuted\s*\|\| playbackForcedMuted\s*\|\| takeReviewForcedMuted;/,
  );
  assert.match(listen, /if \(micForcedMuted \|\| roomMicForcedMuted\) return 'mic'/);
  assert.match(listen, /function restoreAfterMic[\s\S]*if \(roomMicForcedMuted\)[\s\S]*listen\.micOwned/,
    'a local terminal event must not unmute while another tab still owns the room Mic');
  assert.match(listen, /setRoomMicForcedMute\(Boolean\(participantId && ownerId === participantId\)\)/,
    'all tabs with the owner participant identity must follow server Mic ownership');
  const sessionListenerAt = listen.indexOf("window.addEventListener('relay-session-status'");
  const replayAt = listen.indexOf("window.dispatchEvent(new Event('relay-request-session-status'))", sessionListenerAt);
  assert.ok(sessionListenerAt >= 0 && replayAt > sessionListenerAt,
    'Listen must subscribe before requesting the initial authoritative replay');
  assert.match(listen, /if \(micForcedMuted \|\| roomMicForcedMuted \|\| playbackForcedMuted \|\| takeReviewForcedMuted\) return/,
    'forced room ownership or local review cannot be bypassed by the Listen toggle');
});

test('hardware input ending completes the same Mic lifecycle', () => {
  const trackStart = app.indexOf("track?.addEventListener('ended'");
  const graphStart = app.indexOf('const source = captureContext.createMediaStreamSource(captureStream)', trackStart);
  assert.ok(trackStart >= 0 && graphStart > trackStart);
  const handler = app.slice(trackStart, graphStart);
  assert.match(handler, /if \(!captureIsCurrent\(\)\) return/,
    'a stale track callback must not terminate a replacement capture');
  assert.match(handler, /stop\(false, \{ releaseMic: true \}\)/);
  assert.match(handler, /relay-microphone-ended'[\s\S]*reason: 'input-ended'/);
});

test('Mic startup is single-flight, deadline-bound, and disposes late permission capture', () => {
  const startAt = app.indexOf('async function startPublisher');
  const requestAt = app.indexOf('async function requestPublisherStart', startAt);
  assert.ok(startAt >= 0 && requestAt > startAt);
  const startup = app.slice(startAt, requestAt);

  assert.match(app, /const micStartup = new MicStartupGate\(\)/);
  assert.match(startup, /publisherButton\.disabled = true[\s\S]*navigator\.mediaDevices\.getUserMedia/,
    'the button must become single-flight before the permission promise starts');
  assert.match(startup, /micStartup\.wait\([\s\S]*waiting for microphone permission/);
  assert.match(startup, /dispose: \(stream\) => stream\.getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\)/);
  assert.match(startup, /loading the microphone audio processor/);
  assert.match(startup, /starting microphone audio/);
  assert.match(app, /async function stop[\s\S]*micStartup\.cancel\(\)/,
    'every local stop invalidates an in-flight startup before late browser work can resolve');
  assert.match(app, /if \(publisherStartRequest\) return publisherStartRequest/,
    'duplicate clicks and takeover events must share one startup request');
});

test('initial Relay connection failure remains cancellable instead of trapping an active Mic', () => {
  const activeAt = app.indexOf('setPublisherActive(true)');
  const disabledAt = app.indexOf('publisherButton.disabled = true', activeAt);
  const connectAt = app.indexOf('await connectPublisherSocket(sessionEpoch)', disabledAt);
  const retryAt = app.indexOf('schedulePublisherReconnect(sessionEpoch)', connectAt);
  assert.ok(activeAt >= 0 && disabledAt > activeAt && connectAt > disabledAt && retryAt > connectAt);

  // setPublisherActive(true) makes Release visible before the first control
  // connection succeeds, so the retry loop can always be cancelled locally.
  assert.match(app, /releaseButton\.hidden = !publisherActive/);
});

test('timeline diagnostics attach to the current Song stage instead of retired markup', () => {
  assert.match(youtubeSync, /document\.querySelector\('\.song-stage'\)/);
  assert.doesNotMatch(youtubeSync, /document\.querySelector\('\.youtube-panel'\)/);
  assert.match(youtubeSync, /panel\?\.querySelector\('\.youtube-readout'\)/);
});

test('localized Mic labels are not replaced by the retired English pseudo-label', () => {
  const micStart = actionCss.indexOf('#start-publisher {');
  const confirmStart = actionCss.indexOf('#confirm-takeover {', micStart);
  assert.ok(micStart >= 0 && confirmStart > micStart);
  const micRules = actionCss.slice(micStart, confirmStart);
  assert.match(micRules, /font-size:\s*13px/);
  assert.match(micRules, /#start-publisher::after\s*\{[\s\S]*content:\s*none/);
});
