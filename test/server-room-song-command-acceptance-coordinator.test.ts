import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseTypeScriptSource, variableInitializerCode } from './support/source-contract.js';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const serverSource = parseTypeScriptSource(new URL('../src/server.ts', import.meta.url), server);
const orchestration = readFileSync(new URL('../src/relay-song-orchestration.ts', import.meta.url), 'utf8');
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
    /import \{ createRelaySongCommandOrchestration, createRelaySongLifecycle \} from '\.\/relay-song-orchestration\.js';/,
  );
  assert.match(
    server,
    /const relaySongCommands = createRelaySongCommandOrchestration</,
  );

  const block = roomSongCommandBlock();
  assert.match(block, /if \(!socket\.participantId\)/);
  assert.match(block, /playbackTransport\.identity\(socket\)/);
  assert.match(block, /parseRoomSongCommand\(payload\)/);
  assert.match(block, /roomSongCommands\.begin\(/);
  assert.match(block, /rejectRoomSongCommand\(/);
  assert.match(block, /relaySongCommands\.accept\(\{/);
  assert.doesNotMatch(block, /type: 'room-song-command-accepted'/);
  assert.doesNotMatch(block, /roomSongCommands\.pendingForTarget\(commandTarget, nowMs\)/);
  assert.doesNotMatch(block, /playbackTransport\.send\(commandTarget/);
});

test('canonical Song command assembly retains delivery and room-song runtime effects', () => {
  const binding = variableInitializerCode(serverSource, 'relaySongCommands');
  assert.match(binding, /commands: roomSongCommands/);
  assert.match(binding, /song: youtubeTimeline/);
  assert.match(binding, /playback: playbackTransport/);
  assert.match(binding, /commandStatusPayload: roomSongCommandStatusPayload/);
  assert.match(binding, /send: sendJson, broadcast: broadcastJson/);
  assert.match(orchestration, /createRelayRoomSongCommandAcceptanceCoordinator</);
  assert.match(orchestration, /sendAccepted: \(socket, commandId, revision, duplicate\) => \{/);
  assert.match(orchestration, /type: 'room-song-command-accepted'/);
  assert.match(
    orchestration,
    /pendingForTarget: \(target, nowMs\) => commands\.pendingForTarget\(target, nowMs\)/,
  );
  assert.match(
    orchestration,
    /sendApply: \(target, command\) => playback\.send\(target, applyPayload\(command\)\)/,
  );
  assert.match(
    orchestration,
    /reportStatus: \(nowMs\) => effects\.broadcast\(queries\.commandStatusPayload\(nowMs\)\)/,
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
