import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const coordinator = readFileSync(
  new URL('../src/relay-room-song-command-acceptance-coordinator.ts', import.meta.url),
  'utf8',
);

function roomSongCommandBlock() {
  const command = server.indexOf('const commandProtocol = createRelayCommandProtocol<RelaySocket>({');
  const start = server.indexOf('  roomSongCommand: (socket, payload) => {', command);
  const end = server.indexOf('\n  },\n  roomSongCommandFailed:', start);
  assert.ok(command >= 0 && start > command && end > start, 'roomSongCommand block must remain identifiable');
  return server.slice(start, end);
}

test('server retains room-song admission and begin authority before the acceptance seam', () => {
  assert.match(
    server,
    /import \{ createRelayRoomSongCommandAcceptanceCoordinator \} from '\.\/relay-room-song-command-acceptance-coordinator\.js';/,
  );
  assert.match(
    server,
    /const roomSongCommandAcceptanceCoordinator = createRelayRoomSongCommandAcceptanceCoordinator</,
  );

  const block = roomSongCommandBlock();
  assert.match(block, /if \(!socket\.participantId\)/);
  assert.match(block, /playbackTransport\.identity\(socket\)/);
  assert.match(block, /parseRoomSongCommand\(payload\)/);
  assert.match(block, /roomSongCommands\.begin\(/);
  assert.match(block, /rejectRoomSongCommand\(/);
  assert.match(block, /roomSongCommandAcceptanceCoordinator\.accept\(\{/);
  assert.doesNotMatch(block, /type: 'room-song-command-accepted'/);
  assert.doesNotMatch(block, /roomSongCommands\.pendingForTarget\(commandTarget, nowMs\)/);
  assert.doesNotMatch(block, /playbackTransport\.send\(commandTarget/);
});

test('server composition retains delivery and room-song runtime effects', () => {
  assert.match(server, /sendAccepted: \(socket, commandId, revision, duplicate\) => \{/);
  assert.match(server, /type: 'room-song-command-accepted'/);
  assert.match(
    server,
    /pendingForTarget: \(target, nowMs\) => roomSongCommands\.pendingForTarget\(target, nowMs\)/,
  );
  assert.match(
    server,
    /sendApply: \(target, command\) => playbackTransport\.send\(target, roomSongCommandApplyPayload\(command\)\)/,
  );
  assert.match(
    server,
    /reportStatus: \(nowMs\) => broadcastJson\(roomSongCommandStatusPayload\(nowMs\)\)/,
  );
});

test('acceptance coordinator owns no command/session/playback authority', () => {
  assert.doesNotMatch(
    coordinator,
    /from '\.\/(?:room-song-command-session|room-song-command-runtime|playback-transport-runtime|song-session)\.js'/,
  );
  assert.doesNotMatch(
    coordinator,
    /RoomSongCommandSession|RoomSongCommandRuntime|PlaybackTransportRuntime|parseRoomSongCommand|micOwnerId/,
  );
});
