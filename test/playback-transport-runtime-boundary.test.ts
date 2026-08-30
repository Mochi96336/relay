import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const runtime = fs.readFileSync(path.join(root, 'src/playback-transport-runtime.ts'), 'utf8');
const server = fs.readFileSync(path.join(root, 'src/server.ts'), 'utf8');

function withoutComments(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

test('PlaybackTransportRuntime owns socket identity and routing without absorbing song authority', () => {
  assert.match(server, /const playbackTransport = new PlaybackTransportRuntime<RelaySocket>/);
  assert.doesNotMatch(
    server,
    /function playbackIdentityForSocket|function samePlaybackIdentity|function sendToPlayback|function selectPlaybackHandoffTarget|function playbackTransportIsConnected/,
  );
  assert.doesNotMatch(
    server,
    /socket\.playback(?:ParticipantId|TransportId|Generation|MicIntentAtMs)/,
  );

  const production = withoutComments(runtime);
  assert.match(production, /selectHandoffTarget/);
  assert.match(production, /connected\(identity: PlaybackIdentity\)/);
  assert.match(production, /send\(identity: PlaybackIdentity, payload: unknown\)/);
  assert.doesNotMatch(
    production,
    /new SongSession|RoomSongCommandRuntime|ParticipantSession|AudioSession|TakeController|youtubeTimeline|roomSongCommands|participants|broadcastJson/,
  );

  assert.match(server, /const youtubeTimeline = new SongSession\(\);/);
  assert.match(server, /const roomSongCommands = new RoomSongCommandRuntime\(\);/);
  assert.match(server, /participants\.micOwnerId/);
  assert.match(server, /playbackTransport\.send\(/);
});
