import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const listenSource = readFileSync(new URL('../public/listen.js', import.meta.url), 'utf8');
const transactionSource = readFileSync(new URL('../public/mic-lifecycle-transaction.js', import.meta.url), 'utf8');

test('a stale Mic terminal completion cannot unmute a replacement Mic session', () => {
  assert.match(
    appSource,
    /function setPublisherActive[\s\S]*dispatchRelayEvent\('relay-microphone-local-state', \{ active: publisherActive \}\)/,
    'app must publish the authoritative local Mic lifecycle used to rotate teardown sessions',
  );
  assert.match(
    transactionSource,
    /relay-microphone-local-state[\s\S]*event\.detail\?\.active === true[\s\S]*browserMicSessionEpoch \+= 1/,
    'each replacement local Mic session must get an independent teardown transaction key',
  );
  assert.match(
    appSource,
    /function finishMicrophoneSession[\s\S]*micLifecycle\.run\([\s\S]*isCurrent: \(stoppedEpoch\) => publisherSessionEpoch === stoppedEpoch[\s\S]*dispatchRelayEvent\('relay-microphone-ended'/,
    'the publisher epoch must fence terminal completion before Listen can observe Mic ended',
  );
  assert.match(
    listenSource,
    /function restoreAfterMicBoundary[\s\S]*claimMicrophoneAudio\(false\)[\s\S]*restoreAfterMic\([^)]*\);/,
  );
  assert.doesNotMatch(
    listenSource,
    /function restoreAfterMicBoundary[\s\S]*setTimeout\(/,
    'Listen must consume the authoritative post-teardown event instead of guessing a later task',
  );
});
