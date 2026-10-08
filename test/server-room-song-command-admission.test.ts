import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');

function roomSongCommandBlock() {
  const command = server.indexOf('const commandProtocol = createRelayCommandProtocol<RelaySocket>({');
  const start = server.indexOf('  roomSongCommand: (socket, payload) => {', command);
  const end = server.indexOf('\n  },\n  roomSongCommandFailed:', start);
  assert.ok(command >= 0 && start > command && end > start, 'roomSongCommand block must remain identifiable');
  return server.slice(start, end);
}

test('server retains room-song admission and begin authority in the handler', () => {
  const block = roomSongCommandBlock();
  assert.match(block, /if \(!socket\.participantId\)/);
  assert.match(block, /playbackTransport\.identity\(socket\)/);
  assert.match(block, /parseRoomSongCommand\(payload\)/);
  assert.match(block, /roomSongCommands\.begin\(/);
  assert.match(block, /rejectRoomSongCommand\(/);
  assert.match(block, /roomSongCommandAccepted\(socket, decision\.command, decision\.duplicate, nowMs\)/);
  assert.doesNotMatch(block, /type: 'room-song-command-accepted'/);
  assert.doesNotMatch(block, /roomSongCommands\.pendingForTarget\(commandTarget, nowMs\)/);
  assert.doesNotMatch(block, /playbackTransport\.send\(commandTarget/);
});
