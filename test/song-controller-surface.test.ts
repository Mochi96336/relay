import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('playback view carries canonical Mic ownership into the Song surface', async () => {
  const source = await readFile(new URL('../public/youtube-sync.js', import.meta.url), 'utf8');

  assert.match(source, /relay-session-status/);
  assert.match(source, /latestMicOwnerId === participantId/);
  assert.match(source, /isMicOwner:/);
  assert.match(source, /latestMicOwnerKnown && latestMicOwnerId === null/);
  assert.match(source, /isMicFree:/);
  assert.match(source, /relay-request-session-status/);
  assert.match(source, /message\.type === 'session-status'/,
    'the playback socket must consume Mic ownership directly');
  assert.match(source, /type: 'session-status-request'/,
    'the playback socket must request a replay after every reconnect');
  assert.match(source, /reduceSessionOwnership\(latestSessionOwnership, message\)/,
    'cross-socket Mic snapshots must not rewind the visible permission');
});

test('a recoverable Mic owner keeps the music snapshot and Change Song action', async () => {
  const source = await readFile(new URL('../public/song-surface.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../public/song-surface.css', import.meta.url), 'utf8');

  assert.match(source, /canChangeRoomSong/);
  assert.match(source, /isMicFree: detail\.isMicFree === true/);
  assert.match(source, /changeButton\.hidden = !canChange \|\| !videoId/);
  assert.match(source, /role === 'empty' && Boolean\(videoId\)/,
    'a stale or disconnected holder must not erase the room Song surface');
  assert.match(source, /if \(!canEditCurrentSong\) return/,
    'the painted Change Song permission must also gate its click handler');
  assert.match(source, /nextRole === 'empty' && !videoId && canChange/,
    'first Song selection must use the same canonical Mic permission');
  assert.match(source, /form\.hidden = role === 'preparing' \|\| !canChange/,
    'a non-owner must not see an actionable empty-room Song form');
  assert.match(source, /!canChange && !handoffInProgress/,
    'a transient playback handoff must hide, but not consume, a desktop Change Song click');
  assert.match(styles, /data-playback-role="observer"\]\[data-song-editing="true"\]/,
    'only the explicit authorized editing state may reopen an observer form');
  assert.doesNotMatch(styles, /data-playback-role="observer"\]\[data-playback-health=/,
    'leader health alone must not expose a change form to every observer');
});

test('terminal handoff preparation uses the non-ended proof position', async () => {
  const source = await readFile(new URL('../public/youtube.js', import.meta.url), 'utf8');

  assert.match(source, /handoffPreparationPosition/);
  assert.match(source, /startSeconds: preparationTime/);
  assert.match(source, /currentState === 0 && preparationTime < pendingHandoff\.targetTime/,
    'a reused ENDED prewarm must seek back into renderable media');
});
