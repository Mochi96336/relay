import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseTypeScriptSource, variableInitializerCode } from './support/source-contract.js';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const lifecycle = parseTypeScriptSource(new URL('../src/relay-song-orchestration.ts', import.meta.url),
  readFileSync(new URL('../src/relay-song-orchestration.ts', import.meta.url), 'utf8'));
const serverSource = parseTypeScriptSource(new URL('../src/server.ts', import.meta.url), server);
const composition = variableInitializerCode(lifecycle, 'disconnect');
const binding = variableInitializerCode(serverSource, 'relaySongLifecycle');

const coordinator = readFileSync(
  new URL('../src/relay-playback-disconnect-coordinator.ts', import.meta.url),
  'utf8',
);

test('server delegates only playback close ordering through the coordinator seam', () => {
  assert.match(server, /createRelaySongLifecycle<RelaySocket>/);
  assert.match(server, /relaySongLifecycle\.disconnect\(socket\)/);
  assert.doesNotMatch(server, /const closingPlaybackIdentity = playbackTransport\.identity\(socket\)/);
});

test('server composition still owns playback disconnect authority and broadcasts', () => {
  assert.match(binding, /song: youtubeTimeline/);
  assert.match(binding, /commands: roomSongCommands/);
  assert.match(binding, /playback: playbackTransport/);
  assert.match(binding, /commandOrchestration: relaySongCommands/);
  assert.match(binding, /commandStatusPayload: roomSongCommandStatusPayload/);
  assert.match(binding, /broadcast: broadcastJson/);
  assert.match(binding, /now: \(\) => performance\.now\(\)/);
  assert.match(composition, /^createRelayPlaybackDisconnectCoordinator/);
  assert.match(composition, /identity: \(socket\) => playback\.identity\(socket\)/);
  assert.match(composition, /now: \(\) => clock\.now\(\)/);
  assert.match(composition, /commands\.pendingForTarget\(identity, nowMs\)/);
  assert.match(composition, /commands\.fail\(identity, commandId\)/);
  assert.match(composition, /commandOrchestration\.reportFailure\(commandId, 'playback-disconnected', nowMs\)/);
  assert.match(composition, /effects\.broadcast\(queries\.commandStatusPayload\(nowMs\)\)/);
  assert.match(composition, /song\.detach\(identity\)/);
  assert.match(composition, /effects\.broadcast\(song\.statusPayload\(\)\)/);
  assert.match(composition, /effects\.broadcast\(song\.roomStatusPayload\(\)\)/);

  assert.doesNotMatch(
    coordinator,
    /PlaybackTransportRuntime|RoomSongCommandRuntime|SongSession|playbackTransport|roomSongCommands|youtubeTimeline|broadcastJson|performance\.now/,
  );
});

test('Robot, Mic and Backing dispatch plus participant close authority remain in the socket close boundary', () => {
  const closeStart = server.indexOf("socket.on('close', () => {");
  assert.ok(closeStart >= 0);
  const closeEnd = server.indexOf("\n  });\n});\n\nwss.on('close'", closeStart);
  assert.ok(closeEnd > closeStart);
  const close = server.slice(closeStart, closeEnd);

  assert.match(close, /if \(!socket\.replaced\) \{/);
  assert.ok(close.indexOf('relaySongLifecycle.disconnect(socket)') >= 0);
  assert.ok(close.indexOf('relaySongLifecycle.disconnect(socket)') < close.indexOf('if (!socket.replaced)'));
  assert.match(close, /relayRobotMapping\.disconnectSource\(socket\)/);
  assert.match(close, /relayMicLifecycle\.disconnect\(socket\)/);
  assert.match(close, /backingDisconnectCoordinator\.handle\(socket\)/);
  assert.match(close, /participants\.detach\(socket\.participantConnectionId, Date\.now\(\)\)/);
});
