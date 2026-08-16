import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const youtube = readFileSync(new URL('../public/youtube.js', import.meta.url), 'utf8');
const surface = readFileSync(new URL('../public/song-surface.js', import.meta.url), 'utf8');

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

test('stale observer gets both resume and replace-song recovery affordances', () => {
  assert.match(surface, /canRecoverPlayback/);
  assert.match(surface, /id = 'recover-youtube'/);
  assert.match(surface, /relay:recover-room-song/);
  assert.match(surface, /role === 'observer' && !recoverable/,
    'only a healthy observer should have the song form hidden');
  assert.match(surface, /在這支手機繼續播放/);
  assert.match(surface, /播放主控已失聯/);
});

test('recovery button uses the same server-authorized room command path as normal playback actions', () => {
  const recoveryStart = youtube.indexOf("window.addEventListener('relay:recover-room-song'");
  const sentStart = youtube.indexOf("window.addEventListener('relay:room-song-command-sent'", recoveryStart);
  assert.ok(recoveryStart >= 0 && sentStart > recoveryStart);
  const recovery = youtube.slice(recoveryStart, sentStart);

  assert.match(recovery, /requestRoomSongCommand\(\{ action: 'play' \}\)/);
  assert.doesNotMatch(recovery, /player\.playVideo|youtube-telemetry/,
    'recovery must not bypass server command authority');
});
