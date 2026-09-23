import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const presence = readFileSync(new URL('../public/presence.js', import.meta.url), 'utf8');
const listen = readFileSync(new URL('../public/listen.js', import.meta.url), 'utf8');
const youtubeSync = readFileSync(new URL('../public/youtube-sync.js', import.meta.url), 'utf8');
const actionCss = readFileSync(new URL('../public/action-language.css', import.meta.url), 'utf8');
const styleCss = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
const micActions = readFileSync(new URL('../public/mic-actions.js', import.meta.url), 'utf8');

test('local Mic capture publishes an explicit lifecycle independent of server presence', () => {
  assert.match(app, /function setPublisherActive\(active\)[\s\S]*relayActiveRole = publisherActive \? 'publisher' : null/);
  assert.match(app, /dispatchRelayEvent\('relay-microphone-local-state', \{ active: publisherActive \}\)/);

  assert.match(presence, /let localPublisherActive = window\.relayActiveRole === 'publisher'/);
  assert.match(presence, /relay-microphone-local-state/);
  assert.match(presence, /releaseVisible: Boolean\(mine \|\| localPublisherActive\)/);
  assert.match(presence, /relay-mic-action-state/);
  assert.doesNotMatch(presence, /releaseButton\.hidden\s*=/);
  assert.doesNotMatch(app, /releaseButton\.hidden\s*=/);
  assert.match(micActions, /releaseButton\.hidden = state\.releaseVisible !== true/);
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
  assert.match(appRelease, /finishMicrophoneSession\('released', \{[\s\S]*releaseMic: true/);
  assert.doesNotMatch(appRelease, /dispatchRelayEvent\('relay-microphone-ended'/,
    'normal release must not bypass the shared teardown transaction');
});

test('Mic terminal lifecycle tears down before Listen is allowed to recover', () => {
  const restoreStart = listen.indexOf('function restoreAfterMicBoundary');
  const roomMuteStart = listen.indexOf('function setRoomMicForcedMute', restoreStart);
  assert.ok(restoreStart >= 0 && roomMuteStart > restoreStart);
  const restoreBoundary = listen.slice(restoreStart, roomMuteStart);
  assert.match(restoreBoundary, /claimMicrophoneAudio\(false\);[\s\S]*restoreAfterMic\(phase\);/);
  assert.doesNotMatch(restoreBoundary, /setTimeout/,
    'Listen must consume the completed transaction instead of guessing capture cleanup timing');

  assert.match(
    app,
    /function finishMicrophoneSession\(reason,[\s\S]*micLifecycle\.run\(\{[\s\S]*stop: \(\) => stop\(false, \{ releaseMic \}\),[\s\S]*isCurrent: \(stoppedEpoch\) => publisherSessionEpoch === stoppedEpoch,[\s\S]*dispatchRelayEvent\('relay-microphone-ended', \{ reason \}\)/,
    'ended must be emitted only by the shared post-stop transaction',
  );
  assert.match(listen, /window\.addEventListener\('relay-microphone-ended',[\s\S]*restoreAfterMicBoundary/);
  assert.match(listen, /window\.addEventListener\('relay-microphone-start-failed',[\s\S]*restoreAfterMicBoundary/);
  assert.doesNotMatch(listen, /window\.addEventListener\('relay-mic-busy'/);
  assert.doesNotMatch(listen, /window\.addEventListener\('relay-mic-takeover-rejected'/);

  const busyStart = app.indexOf("if (message.type === 'mic-busy')");
  const takeoverStart = app.indexOf("if (message.type === 'mic-takeover-rejected')", busyStart);
  const revokedStart = app.indexOf("if (message.type === 'mic-revoked')", takeoverStart);
  const supersededStart = app.indexOf("if (message.type === 'publisher-superseded')", revokedStart);
  const registeredStart = app.indexOf("message.type === 'registered'", supersededStart);
  assert.ok(
    busyStart >= 0
      && takeoverStart > busyStart
      && revokedStart > takeoverStart
      && supersededStart > revokedStart
      && registeredStart > supersededStart,
  );

  const busy = app.slice(busyStart, takeoverStart);
  const takeover = app.slice(takeoverStart, revokedStart);
  const revoked = app.slice(revokedStart, supersededStart);
  const superseded = app.slice(supersededStart, registeredStart);
  assert.match(busy, /finishMicrophoneSession\('busy'\)/);
  assert.match(takeover, /finishMicrophoneSession\('takeover-rejected'\)/);
  assert.match(revoked, /finishMicrophoneSession\('revoked'\)/);
  assert.match(superseded, /finishMicrophoneSession\('superseded'\)/);
  for (const terminalPath of [busy, takeover, revoked, superseded]) {
    assert.doesNotMatch(terminalPath, /dispatchRelayEvent\('relay-microphone-ended'/,
      'server terminal paths must not emit ended before shared teardown completion');
  }
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
  assert.match(listen, /userMuted[\s\S]*micForcedMuted[\s\S]*roomMicForcedMuted[\s\S]*playbackForcedMuted[\s\S]*takeReviewForcedMuted/);
  assert.match(listen, /if \(micForcedMuted \|\| roomMicForcedMuted\) return 'mic'/);
  assert.match(listen, /function restoreAfterMic[\s\S]*if \(roomMicForcedMuted\)[\s\S]*reconcile\('mic-owned'\)/,
    'a local terminal event must not unmute while another tab still owns the room Mic');
  assert.match(listen, /setRoomMicForcedMute\(Boolean\(participantId && ownerId === participantId\)\)/,
    'all tabs with the owner participant identity must follow server Mic ownership');
  const sessionListenerAt = listen.indexOf("window.addEventListener('relay-session-status'");
  const replayAt = listen.indexOf("window.dispatchEvent(new Event('relay-request-session-status'))", sessionListenerAt);
  assert.ok(sessionListenerAt >= 0 && replayAt > sessionListenerAt,
    'Listen must subscribe before requesting the initial authoritative replay');
  assert.match(listen, /if \(micForcedMuted \|\| roomMicForcedMuted \|\| playbackForcedMuted \|\| takeReviewForcedMuted\) return/,
    'forced room ownership cannot be bypassed by the Listen toggle');
});

test('capture AudioWorklet processorerror uses one bounded current-graph rebuild before grace fallback', () => {
  const installAt = app.indexOf('function installCaptureGraph');
  const roleAt = app.indexOf('// recorder.js reads this', installAt);
  assert.ok(installAt >= 0 && roleAt > installAt);
  const install = app.slice(installAt, roleAt);

  assert.match(install, /processorErrorListener: null/);
  assert.match(install, /capture\.addEventListener\('processorerror', graph\.processorErrorListener\)/);
  assert.match(
    install,
    /graph\.processorErrorListener = \(\) => \{[\s\S]*if \(!captureGraphIsCurrent\(graph\)\) return;[\s\S]*micCaptureRecovery\.noteProcessorError\(captureSnapshot\(\)\)/,
    'only the currently authoritative capture graph may spend processor-error recovery authority',
  );
  assert.match(
    install,
    /if \(decision\.rebuild\) \{[\s\S]*rebuildPublisherCaptureGraph\('processor-error'\)/,
    'the first terminal processor error reuses the existing graph replacement path',
  );
  assert.match(
    install,
    /if \(!decision\.exhausted\) return;[\s\S]*finishMicrophoneSession\('processor-error-repeated', \{[\s\S]*releaseMic: false/,
    'a replacement processor that crashes again before fresh PCM must enter bounded reconnect grace instead of looping generations',
  );
  assert.match(install, /Retry Mic to reconnect it/);

  const disposeAt = app.indexOf('function disposeCaptureGraph');
  const currentAt = app.indexOf('function captureGraphIsCurrent', disposeAt);
  assert.ok(disposeAt >= 0 && currentAt > disposeAt);
  const dispose = app.slice(disposeAt, currentAt);
  assert.match(
    dispose,
    /removeEventListener\?\.\('processorerror', graph\.processorErrorListener\)/,
    'retired AudioWorklet nodes must lose processorerror authority',
  );

  const rebuildAt = app.indexOf('function rebuildPublisherCaptureGraph');
  const stopAt = app.indexOf('async function stop(', rebuildAt);
  assert.ok(rebuildAt >= 0 && stopAt > rebuildAt);
  const rebuild = app.slice(rebuildAt, stopAt);
  assert.match(
    rebuild,
    /if \(captureGraphRebuildPromise\) return captureGraphRebuildPromise/,
    'processorerror recovery must still share the physical single-flight rebuild',
  );
});

test('unexpected capture AudioContext closure enters bounded Mic reconnect grace', () => {
  const startAt = app.indexOf('async function startPublisher');
  const streamAt = app.indexOf('mediaStream = preparedStream', startAt);
  assert.ok(startAt >= 0 && streamAt > startAt);
  const startup = app.slice(startAt, streamAt);

  const stateAt = startup.indexOf("captureContext.addEventListener('statechange'");
  assert.ok(stateAt >= 0);
  const stateHandler = startup.slice(stateAt);

  assert.match(
    stateHandler,
    /if \(!publisherActive \|\| audioContext !== captureContext\) return/,
    'stale or intentional context closure must not terminate a replacement/currently stopped session',
  );
  assert.match(stateHandler, /captureContext\.state === 'closed'/);
  assert.match(
    stateHandler,
    /finishMicrophoneSession\('context-closed', \{[\s\S]*releaseMic: false/,
    'terminal unexpected context closure must use reconnect grace, not explicit room-Mic release',
  );
  assert.match(stateHandler, /Retry Mic to reconnect it/);
  assert.match(
    stateHandler,
    /captureContext\.state === 'closed'[\s\S]*return;[\s\S]*shouldRequestAudioResume/,
    'closed is terminal and must not fall through to the resume-only path',
  );

  const stopAt = app.indexOf('async function stop(');
  const startPublisherAt = app.indexOf('async function startPublisher', stopAt);
  const stop = app.slice(stopAt, startPublisherAt);
  assert.match(
    stop,
    /audioContext = null;[\s\S]*setPublisherActive\(false\);[\s\S]*await closingContext\.close\(\)/,
    'intentional stop must revoke callback authority before closing the captured old context',
  );
});

test('hardware input ending uses Mic reconnect grace instead of explicit release', () => {
  const trackStart = app.indexOf("track?.addEventListener('ended'");
  const watchdogStart = app.indexOf("micCaptureRecovery.start(captureSnapshot(), 'startup')", trackStart);
  assert.ok(trackStart >= 0 && watchdogStart > trackStart);
  const handler = app.slice(trackStart, watchdogStart);
  assert.match(handler, /if \(!captureIsCurrent\(\)\) return/,
    'a stale track callback must not terminate a replacement Mic session');
  assert.match(
    handler,
    /finishMicrophoneSession\('input-ended', \{[\s\S]*releaseMic: false/,
    'unexpected hardware/route loss must close transport into reconnect grace, not send terminal release',
  );
  assert.match(handler, /Retry Mic to reconnect it/);
  assert.doesNotMatch(handler, /dispatchRelayEvent\('relay-microphone-ended'/);
});

test('confirmed active input removal enters Mic reconnect grace without guessing on generic devicechange', () => {
  const installAt = app.indexOf('function installCaptureGraph');
  const roleAt = app.indexOf('// recorder.js reads this', installAt);
  assert.ok(installAt >= 0 && roleAt > installAt);
  const install = app.slice(installAt, roleAt);

  assert.match(install, /mediaDevices\?\.enumerateDevices/);
  assert.match(install, /mediaDevices\?\.addEventListener/);
  assert.match(install, /deviceChangeCheckPending/,
    'bursty devicechange events must share one presence check');
  assert.match(install, /track\.readyState === 'ended'/,
    'track ended owns its existing terminal callback and must not double-trigger device removal');
  assert.match(install, /captureTrackDeviceId\(track\)/,
    'the active capture device id is the removal authority');
  assert.match(
    install,
    /devices\.filter\(\(device\) => device\?\.kind === 'audioinput'\)/,
    'device presence must be proved from the audio-input subset only',
  );
  assert.match(
    install,
    /if \(audioInputs\.length === 0\) return/,
    'an empty or filtered enumerateDevices response is ambiguous, not removal authority',
  );
  assert.match(
    install,
    /audioInputs\.some\([\s\S]*device\.deviceId === deviceId/,
    'unrelated output/input changes must leave the active Mic alone',
  );
  assert.match(
    install,
    /finishMicrophoneSession\('input-device-removed', \{[\s\S]*releaseMic: false/,
    'only confirmed active-input disappearance may enter the bounded reconnect grace',
  );
  assert.match(install, /Retry Mic to reconnect it/);
  assert.match(
    install,
    /catch\(\(error\) => \{[\s\S]*presence check failed/,
    'enumeration failure is diagnostic only and cannot tear down a live capture',
  );

  const disposeAt = app.indexOf('function disposeCaptureGraph');
  const currentAt = app.indexOf('function captureGraphIsCurrent', disposeAt);
  assert.ok(disposeAt >= 0 && currentAt > disposeAt);
  const dispose = app.slice(disposeAt, currentAt);
  assert.match(
    dispose,
    /removeEventListener\?\.\('devicechange', graph\.deviceChangeListener\)/,
    'retired capture graphs must not keep devicechange authority',
  );
});

test('live Mic input A→B becomes a capture-generation boundary instead of false removal', () => {
  const identityAt = app.indexOf('function captureTrackDeviceId');
  const recoveredAt = app.indexOf('function announceCaptureRecovered', identityAt);
  assert.ok(identityAt >= 0 && recoveredAt > identityAt);
  const identity = app.slice(identityAt, recoveredAt);

  assert.match(identity, /track\?\.getSettings\?\.\(\)\.deviceId/);
  assert.match(identity, /graph\.inputDeviceId === null/);
  assert.match(
    identity,
    /currentDeviceId === graph\.inputDeviceId/,
    'same physical input must remain the same capture generation',
  );
  assert.match(
    identity,
    /rebuildPublisherCaptureGraph\('input-device-changed'\)/,
    'a live track routed to a different physical input must advance capture generation',
  );

  const installAt = app.indexOf('function installCaptureGraph');
  const roleAt = app.indexOf('// recorder.js reads this', installAt);
  assert.ok(installAt >= 0 && roleAt > installAt);
  const install = app.slice(installAt, roleAt);
  assert.match(
    install,
    /inputDeviceId: captureTrackDeviceId\(captureStream\.getAudioTracks\?\.\(\)\[0\] \?\? null\)/,
    'each graph must remember the physical input identity it was installed against',
  );
  const routeChecks = install.match(/rebuildCaptureForInputDeviceChange\(graph\)/g) ?? [];
  assert.ok(
    routeChecks.length >= 2,
    'devicechange must compare track identity both before and after asynchronous enumeration',
  );
  assert.match(
    install,
    /const confirmedDeviceId = captureTrackDeviceId\(track\);[\s\S]*if \(confirmedDeviceId !== deviceId\) return/,
    'A disappearing while the browser auto-routes to B cannot be misclassified as terminal removal',
  );

  const refreshAt = app.indexOf('const refreshCaptureConfiguration = () => {');
  const mutedAt = app.indexOf('captureInputMuted =', refreshAt);
  assert.ok(refreshAt >= 0 && mutedAt > refreshAt);
  const refresh = app.slice(refreshAt, mutedAt);
  assert.match(
    refresh,
    /activeCaptureGraph[\s\S]*rebuildCaptureForInputDeviceChange\(activeCaptureGraph\)[\s\S]*\) return;[\s\S]*sendAudioUplinkHealth\(\)/,
    'configurationchange-only route switches must rebuild before an old-generation health snapshot can be sent',
  );
});

test('capture rebuild failure also falls back to bounded Mic reconnect grace', () => {
  const rebuildAt = app.indexOf('function rebuildPublisherCaptureGraph');
  const stopAt = app.indexOf('async function stop(', rebuildAt);
  assert.ok(rebuildAt >= 0 && stopAt > rebuildAt);
  const rebuild = app.slice(rebuildAt, stopAt);

  assert.match(
    rebuild,
    /finishMicrophoneSession\('capture-rebuild-failed', \{[\s\S]*releaseMic: false/,
    'local capture recovery failure must preserve server grace instead of explicitly releasing room ownership',
  );
  assert.match(rebuild, /Retry Mic to start a fresh capture/);
});

test('reconnecting self owner gets a user-gesture Retry Mic without minting playback intent', () => {
  assert.match(
    presence,
    /const selfRetry =[\s\S]*mine[\s\S]*!localPublisherActive[\s\S]*latestSession\?\.micConnected === false/,
    'Retry mode exists only for the local-disconnected reconnect-grace state',
  );
  assert.match(
    presence,
    /primaryMode: selfRetry \? 'retry' : currentOwner && !mine \? 'takeover' : 'take'/,
  );

  const clickAt = presence.indexOf("publisherButton.addEventListener('click'");
  const confirmAt = presence.indexOf("confirmTakeoverButton.addEventListener('click'", clickAt);
  assert.ok(clickAt >= 0 && confirmAt > clickAt);
  const click = presence.slice(clickAt, confirmAt);
  assert.match(click, /state\.primaryMode === 'retry'/);
  assert.match(click, /event\.stopImmediatePropagation\(\)/);
  assert.match(click, /relay-retry-microphone/,
    'self retry must stay in the original click gesture while bypassing ordinary Mic intent listeners');

  assert.match(micActions, /retryMode = state\.primaryMode === 'retry'/);
  assert.match(micActions, /t\('system\.issue\.action\.retry-mic'\)/);
  assert.match(
    micActions,
    /state\.mine === true && !retryMode/,
    'healthy Mic ownership in a sibling tab remains hidden rather than becoming retryable',
  );

  assert.doesNotMatch(
    youtubeSync,
    /relay-retry-microphone/,
    'self recovery must not create a new playback Mic intent or move Song playback between tabs',
  );
});

test('recoverable terminal Mic failures preserve reconnect grace while explicit release stays terminal', () => {
  const recoverable = [
    ['input-ended', /finishMicrophoneSession\('input-ended', \{[\s\S]*?releaseMic: false/],
    ['input-device-removed', /finishMicrophoneSession\('input-device-removed', \{[\s\S]*?releaseMic: false/],
    ['context-closed', /finishMicrophoneSession\('context-closed', \{[\s\S]*?releaseMic: false/],
    ['processor-error-repeated', /finishMicrophoneSession\('processor-error-repeated', \{[\s\S]*?releaseMic: false/],
    ['capture-rebuild-failed', /finishMicrophoneSession\('capture-rebuild-failed', \{[\s\S]*?releaseMic: false/],
  ] as const;

  for (const [reason, pattern] of recoverable) {
    assert.match(
      app,
      pattern,
      `${reason} must preserve bounded server reconnect grace instead of sending terminal release-mic`,
    );
  }

  assert.match(
    app,
    /finishMicrophoneSession\('released', \{[\s\S]*?releaseMic: true/,
    'explicit user Release Mic remains terminal and must bypass reconnect grace',
  );
  assert.match(
    app,
    /finishMicrophoneSession\('revoked'\)/,
    'server ownership revocation remains terminal without attempting self-recovery',
  );
  assert.match(
    app,
    /finishMicrophoneSession\('superseded'\)/,
    'newer-tab supersession remains terminal for the stale publisher',
  );
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
  const connectAt = app.indexOf('await connectPublisherSocket(sessionEpoch, generation)', disabledAt);
  const retryAt = app.indexOf('schedulePublisherReconnect(sessionEpoch, generation)', connectAt);
  assert.ok(activeAt >= 0 && disabledAt > activeAt && connectAt > disabledAt && retryAt > connectAt);

  assert.match(presence, /releaseVisible: Boolean\(mine \|\| localPublisherActive\)/);
  assert.match(micActions, /releaseButton\.hidden = state\.releaseVisible !== true/);
});

test('timeline diagnostics stay data-only and never attach to the Live Song stage', () => {
  assert.match(youtubeSync, /relay:playback-diagnostics/);
  assert.doesNotMatch(youtubeSync, /document\.querySelector\('\.song-stage'\)/);
  assert.doesNotMatch(youtubeSync, /server-timeline-state|insertAdjacentElement/);
});

test('localized Mic labels come only from the Mic action presenter', () => {
  const micStart = actionCss.indexOf('#start-publisher {');
  const confirmStart = actionCss.indexOf('#confirm-takeover {', micStart);
  assert.ok(micStart >= 0 && confirmStart > micStart);
  const micRules = actionCss.slice(micStart, confirmStart);
  assert.match(micRules, /font-size:\s*13px/);
  assert.doesNotMatch(actionCss, /#start-publisher::after/);
  assert.doesNotMatch(styleCss, /#start-publisher::after|Take over mic|content:\s*"Take mic"/);
  assert.match(micActions, /publisherButton\.textContent = t\('mic\.takeover'\)/);
  assert.match(micActions, /publisherButton\.textContent = t\('mic\.take'\)/);
  assert.match(micActions, /releaseButton\.textContent = t\('mic\.release'\)/);
  assert.doesNotMatch(micActions, /mic\.microphone|mic\.takeoverConfirm/,
    'retired generic Microphone and duplicate confirm wording must not return');
});
