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

test('the Song surface repaint never rewrites unchanged text', async () => {
  const source = await readFile(new URL('../public/song-surface.js', import.meta.url), 'utf8');

  // The server sweeps the room every 250ms and broadcasts the timeline and room
  // snapshots as a pair, so this surface repaints about eight times a second.
  // Assigning textContent replaces the text node even when the string is
  // identical, and Chrome cancels a click whose pressed node was removed before
  // mouseup: a desktop press that straddled one repaint produced mousedown and
  // mouseup but no click, so Change Song needed a second press. Measured in
  // headless Chrome, a 200ms press landed 0/12 clicks before this guard and
  // 12/12 after.
  assert.match(source, /function setText\(node, value\) \{\s+if \(node\.textContent !== value\) node\.textContent = value;/,
    'repainted text must be compared before it is written');
  assert.match(source, /setText\(changeButton, editing \? t\('song\.done'\) : t\('song\.change'\)\)/,
    'the Change Song label is the click target and must not be rebuilt per sweep');
  assert.doesNotMatch(source, /changeButton\.textContent =/,
    'an unconditional label write drops real desktop clicks');
  for (const node of ['deviceNote', 'headingTitle', 'observerState', 'observerAuthor', 'observerTimeline', 'observerPlaybackState']) {
    assert.doesNotMatch(source, new RegExp(`${node}\\.textContent =`),
      `${node} repaints on every sweep and must go through setText`);
  }
});

test('terminal handoff preparation uses the non-ended proof position', async () => {
  const source = await readFile(new URL('../public/youtube.js', import.meta.url), 'utf8');

  assert.match(source, /handoffPreparationPosition/);
  assert.match(source, /startSeconds: preparationTime/);
  assert.match(source, /currentState === 0 && preparationTime < pendingHandoff\.targetTime/,
    'a reused ENDED prewarm must seek back into renderable media');
});
