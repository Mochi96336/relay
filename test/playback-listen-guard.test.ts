import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const listen = readFileSync(new URL('../public/listen.js', import.meta.url), 'utf8');
const youtubeSync = readFileSync(new URL('../public/youtube-sync.js', import.meta.url), 'utf8');

test('the playback holder never monitors the Relay mix back into the same phone', () => {
  assert.match(listen, /let playbackForcedMuted = false;/);
  assert.match(listen, /return userMuted \|\| micForcedMuted \|\| playbackForcedMuted;/);
  assert.match(listen, /window\.addEventListener\('relay:playback-view'/);
  assert.match(listen, /role === 'holder' \|\| role === 'preparing'/);
  assert.match(listen, /setPlaybackForcedMute\(true\)/);
  assert.match(listen, /role === 'observer' \|\| role === 'empty'/);
  assert.match(listen, /setPlaybackForcedMute\(false\)/);
  assert.match(listen, /Muted while this phone plays the room song\./);
  assert.match(youtubeSync, /new CustomEvent\('relay:playback-view'/,
    'Listen must follow the server-resolved playback role rather than guessing from local YouTube state');
});

test('playback forced mute composes with Mic mute and preserves the user preference', () => {
  assert.match(listen, /if \(micForcedMuted \|\| playbackForcedMuted\) return;/,
    'forced source roles must make the local Listen toggle non-actionable');
  assert.match(listen, /if \(playbackForcedMuted\) \{[\s\S]*Muted while this phone plays the room song/,
    'ending Mic ownership must not resume Listen while this phone still owns playback');
  assert.match(listen, /if \(micForcedMuted\) \{[\s\S]*Muted while this phone has the mic/,
    'giving playback away must not resume Listen while this phone still owns the Mic');
  assert.match(listen, /if \(userMuted\) \{[\s\S]*Muted on this phone/,
    'automatic role changes must not overwrite an explicit user mute');
});
