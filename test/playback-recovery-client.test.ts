import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const youtube = readFileSync(new URL('../public/youtube.js', import.meta.url), 'utf8');
const surface = readFileSync(new URL('../public/song-surface.js', import.meta.url), 'utf8');
const surfaceCss = readFileSync(new URL('../public/song-surface.css', import.meta.url), 'utf8');

test('observer no longer vetoes a room-song recovery command on the client', () => {
  const requestStart = youtube.indexOf('function requestRoomSongCommand');
  const requestEnd = youtube.indexOf('function normalizedDesiredState', requestStart);
  assert.ok(requestStart >= 0 && requestEnd > requestStart);
  const request = youtube.slice(requestStart, requestEnd);

  assert.doesNotMatch(request, /playbackRole === 'observer'/);
  assert.match(request, /relay:room-song-command-intent/);
});

test('server-authorized recovery target may publish command proof before its role snapshot catches up', () => {
  const renderStart = youtube.indexOf('function renderSnapshot');
  const renderEnd = youtube.indexOf('function sampleNow', renderStart);
  assert.ok(renderStart >= 0 && renderEnd > renderStart);
  const render = youtube.slice(renderStart, renderEnd);

  assert.match(render, /playbackRole === 'observer' && mutationContext\?\.source !== 'room-command'/);
  assert.match(render, /relay:youtube-telemetry/);
});

test('Song surface uses canonical Mic state to decide shared replace-song access', () => {
  assert.match(surface, /canChangeRoomSong/);
  assert.match(surface, /isMicOwner: detail\.isMicOwner === true/);
  assert.match(surface, /isMicFree: detail\.isMicFree === true/);
  assert.match(surface, /changeButton\.hidden = !canChange \|\| !videoId/);
  assert.match(surface, /t\('song\.playbackControllerUnavailable'\)/);
  assert.doesNotMatch(surface, /recover-youtube|playback-recovery-actions|在這支手機繼續播放/);

  assert.match(surfaceCss, /data-playback-role="observer"\]\[data-song-editing="true"\][^\n]*\.youtube-form/);
  assert.doesNotMatch(surfaceCss, /data-playback-role="observer"\]\[data-playback-health=/,
    'leader health alone must not expose the form to a non-owner observer');
});

test('the exact playback holder does not lose Change Song while Mic state reconnects', () => {
  assert.match(surface, /canChangeRoomSong/);
  const policy = readFileSync(new URL('../public/playback-policy.js', import.meta.url), 'utf8');
  assert.ok(
    policy.indexOf("hasSong && role === 'holder'") < policy.indexOf('if (isMicFree)'),
    'exact playback authority must be evaluated before the secondary Mic projection',
  );
});

test('server-authorized room recovery requests use the normal playback command path', () => {
  const recoveryStart = youtube.indexOf("window.addEventListener('relay:recover-room-song'");
  const sentStart = youtube.indexOf("window.addEventListener('relay:room-song-command-sent'", recoveryStart);
  assert.ok(recoveryStart >= 0 && sentStart > recoveryStart);
  const recovery = youtube.slice(recoveryStart, sentStart);

  assert.match(recovery, /requestRoomSongCommand\(\{ action: 'play' \}\)/);
  assert.doesNotMatch(recovery, /player\.playVideo|youtube-telemetry/,
    'recovery must not bypass server command authority');
});
