import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const runtime = fs.readFileSync(path.join(root, 'src/room-song-command-runtime.ts'), 'utf8');
const server = fs.readFileSync(path.join(root, 'src/server.ts'), 'utf8');

function withoutComments(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

test('RoomSongCommandRuntime owns command revision without absorbing room or transport authority', () => {
  assert.match(server, /const roomSongCommands = new RoomSongCommandRuntime\(\);/);
  assert.doesNotMatch(server, /let roomSongCommandRevision\s*=/);
  assert.doesNotMatch(server, /new RoomSongCommandSession\(\)/);

  const production = withoutComments(runtime);
  assert.match(production, /private revisionValue = 0;/);
  assert.match(production, /new RoomSongCommandSession\(\)/);
  assert.doesNotMatch(
    production,
    /sendJson|broadcastJson|ParticipantSession|new SongSession|new AudioSession|TakeController|CalibrationSession/,
  );

  // Playback leader/media-clock authority and socket side effects remain server composition work.
  assert.match(server, /const youtubeTimeline = new SongSession\(\);/);
  assert.match(server, /participants\.micOwnerId/);
  assert.match(server, /sendToPlayback\(/);
  assert.match(server, /broadcastJson\(/);
});
