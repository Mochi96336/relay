import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const coordinator = readFileSync(
  new URL('../src/relay-playback-disconnect-coordinator.ts', import.meta.url),
  'utf8',
);

test('server delegates only playback close ordering through the coordinator seam', () => {
  assert.match(server, /createRelayPlaybackDisconnectCoordinator<RelaySocket>/);
  assert.match(server, /playbackDisconnectCoordinator\.handle\(socket\)/);
  assert.doesNotMatch(server, /const closingPlaybackIdentity = playbackTransport\.identity\(socket\)/);
});

test('server composition still owns playback disconnect authority and broadcasts', () => {
  assert.match(server, /identity: \(socket\) => playbackTransport\.identity\(socket\)/);
  assert.match(server, /now: \(\) => performance\.now\(\)/);
  assert.match(server, /roomSongCommands\.pendingForTarget\(identity, nowMs\)/);
  assert.match(server, /roomSongCommands\.fail\(identity, commandId\)/);
  assert.match(server, /broadcastRoomSongCommandFailure\(commandId, 'playback-disconnected', nowMs\)/);
  assert.match(server, /broadcastJson\(roomSongCommandStatusPayload\(nowMs\)\)/);
  assert.match(server, /youtubeTimeline\.detach\(identity\)/);
  assert.match(server, /broadcastJson\(youtubeTimeline\.statusPayload\(\)\)/);
  assert.match(server, /broadcastJson\(youtubeTimeline\.roomStatusPayload\(\)\)/);

  assert.doesNotMatch(
    coordinator,
    /PlaybackTransportRuntime|RoomSongCommandRuntime|SongSession|playbackTransport|roomSongCommands|youtubeTimeline|broadcastJson|performance\.now/,
  );
});

test('Robot dispatch, Mic, Backing and participant close authority remain in the socket close boundary', () => {
  const closeStart = server.indexOf("socket.on('close', () => {");
  assert.ok(closeStart >= 0);
  const closeEnd = server.indexOf("\n  });\n});\n\nwss.on('close'", closeStart);
  assert.ok(closeEnd > closeStart);
  const close = server.slice(closeStart, closeEnd);

  assert.match(close, /if \(!socket\.replaced\) \{/);
  assert.match(close, /robotDisconnectCoordinator\.handle\(socket\)/);
  assert.match(close, /micRuntime\.isPublisher\(socket\)/);
  assert.match(close, /micRuntime\.detachPublisher\(socket\)/);
  assert.match(close, /micTransportGrace\.schedule\(reconnectingOwnerId\)/);
  assert.match(close, /backingRuntime\.isSocket\(socket\)/);
  assert.match(close, /backingRuntime\.detach\(socket\)/);
  assert.match(close, /participants\.detach\(socket\.participantConnectionId, Date\.now\(\)\)/);
});
