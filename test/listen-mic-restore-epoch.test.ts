import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const listenSource = readFileSync(new URL('../public/listen.js', import.meta.url), 'utf8');

test('a stale Mic terminal timer cannot unmute a replacement Mic session', () => {
  assert.match(listenSource, /let micMuteEpoch = 0;/);
  assert.match(
    listenSource,
    /function forceMicMute[\s\S]*micMuteEpoch \+= 1;[\s\S]*micForcedMuted = true;/,
  );
  assert.match(
    listenSource,
    /function restoreAfterMicBoundary[\s\S]*const restoreEpoch = micMuteEpoch;[\s\S]*setTimeout\(\(\) => \{[\s\S]*if \(micMuteEpoch !== restoreEpoch\) return;[\s\S]*restoreAfterMic\([^)]*\);/,
  );
});
