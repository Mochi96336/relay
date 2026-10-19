import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('same-page reconnect cannot rewind an already committed handoff', async () => {
  const sync = await readFile(new URL('../public/youtube-sync.js', import.meta.url), 'utf8');

  assert.match(sync, /let activeHandoffId = null/);
  assert.match(sync, /let activeHandoffPhase = 'idle'/);
  assert.match(
    sync,
    /activeHandoffId === handoffId && activeHandoffPhase === 'committing'\) return/,
    'a replayed prepare for the same committed handoff must be ignored',
  );
  assert.match(
    sync,
    /activeHandoffPhase = 'committing';[\s\S]*relay:song-handoff-commit/,
    'commit must advance the adapter phase before dispatching to the player',
  );
  assert.match(
    sync,
    /activeHandoffId === handoffId\) activeHandoffPhase = 'preparing'/,
    'a real playback failure must re-open preparation so reconnect recovery remains possible',
  );
});

test('playback transport is registered independently and Mic intent is explicit', async () => {
  const sync = await readFile(new URL('../public/youtube-sync.js', import.meta.url), 'utf8');

  assert.match(sync, /type:\s*'playback-hello'/);
  assert.match(sync, /type:\s*'playback-mic-intent'/);
  assert.match(sync, /#start-publisher[^\n]*addEventListener\('click',\s*noteMicIntent\)/);
  assert.match(sync, /relay-request-microphone',\s*noteMicIntent/);
  assert.match(sync, /song-handoff-ready/);
  assert.match(sync, /song-handoff-failed/);
});
