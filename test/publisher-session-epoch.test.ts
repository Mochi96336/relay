import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('publisher callbacks and reconnects are fenced to the Mic session and capture generation', () => {
  assert.match(appSource, /let publisherSessionEpoch = 0;/);
  assert.match(
    appSource,
    /function isCurrentPublisherSession\(sessionEpoch\) \{\s*return publisherSessionEpoch === sessionEpoch && canKeepPublishing\(\);/,
  );
  assert.match(
    appSource,
    /function isCurrentPublisherCapture\(sessionEpoch, expectedGeneration\)[\s\S]*isCurrentPublisherSession\(sessionEpoch\)[\s\S]*captureGeneration >>> 0[\s\S]*expectedGeneration >>> 0/,
  );
  assert.match(
    appSource,
    /async function connectPublisherSocket\(\s*sessionEpoch = publisherSessionEpoch,\s*expectedGeneration = captureGeneration >>> 0,\s*\)[\s\S]*const ws = await connectSocket\(\);[\s\S]*if \(!isCurrentPublisherCapture\(sessionEpoch, expectedGeneration\)\) \{\s*ws\.close\(\);/,
  );
  assert.match(
    appSource,
    /function schedulePublisherReconnect\(\s*sessionEpoch = publisherSessionEpoch,\s*expectedGeneration = captureGeneration >>> 0,\s*\)[\s\S]*if \(socketReconnectTimer !== timer\) return;[\s\S]*connectPublisherSocket\(sessionEpoch, expectedGeneration\)/,
  );
  assert.match(
    appSource,
    /track\?\.addEventListener\('mute',[\s\S]*if \(!captureIsCurrent\(\)\) return;/,
  );
  assert.match(
    appSource,
    /track\?\.addEventListener\('unmute',[\s\S]*if \(!captureIsCurrent\(\)\) return;/,
  );
  assert.match(
    appSource,
    /track\?\.addEventListener\('ended',[\s\S]*if \(!captureIsCurrent\(\)\) return;/,
  );
  assert.match(
    appSource,
    /function captureGraphIsCurrent\(graph\)[\s\S]*activeCaptureGraph === graph[\s\S]*graph\.epoch === captureGraphEpoch/,
  );
  assert.match(
    appSource,
    /function handleCaptureWorkletMessage\(event, graph\)[\s\S]*if \(!captureGraphIsCurrent\(graph\)\) return;[\s\S]*const chunkFirstSampleIndex = captureSampleCursor;/,
  );
});

test('publisher teardown revokes globals before awaiting the old AudioContext close', () => {
  const stopMatch = appSource.match(/async function stop\([\s\S]*?\n}\n\nasync function startPublisher/);
  assert.ok(stopMatch);
  const stopSource = stopMatch[0];
  const awaitClose = stopSource.indexOf('await closingContext.close()');
  assert.ok(awaitClose > 0);

  for (const mutation of [
    'socket = null;',
    'mediaStream = null;',
    'activeNode = null;',
    'audioContext = null;',
    'setPublisherActive(false);',
    'publisherButton.disabled = false;',
  ]) {
    const mutationAt = stopSource.indexOf(mutation);
    assert.ok(mutationAt >= 0, `missing synchronous teardown mutation: ${mutation}`);
    assert.ok(mutationAt < awaitClose, `${mutation} must happen before awaiting close`);
  }

  assert.match(stopSource, /const stoppedEpoch = \+\+publisherSessionEpoch;/);
  assert.match(stopSource, /captureGraphEpoch \+= 1;/);
  assert.match(stopSource, /return stoppedEpoch;/);
});

test('late terminal completion cannot end a replacement publisher session', () => {
  assert.match(
    appSource,
    /\.then\(\(stoppedEpoch\) => \{\s*if \(publisherSessionEpoch !== stoppedEpoch\) return;\s*dispatchRelayEvent\('relay-microphone-ended'/,
  );
});
