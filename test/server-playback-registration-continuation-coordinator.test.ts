import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const coordinator = readFileSync(
  new URL('../src/relay-playback-registration-continuation-coordinator.ts', import.meta.url),
  'utf8',
);

function playbackHelloBlock() {
  const command = server.indexOf('const commandProtocol = createRelayCommandProtocol<RelaySocket>({');
  const start = server.indexOf('  playbackHello: (socket, payload) => {', command);
  const end = server.indexOf('\n  },\n  youtubeTelemetry:', start);
  assert.ok(command >= 0 && start > command && end > start, 'playbackHello block must remain identifiable');
  return server.slice(start, end);
}

test('server retains playback identity validation and registration authority', () => {
  assert.match(
    server,
    /import \{ createRelayPlaybackRegistrationContinuationCoordinator \} from '\.\/relay-playback-registration-continuation-coordinator\.js';/,
  );
  assert.match(server, /const playbackRegistrationContinuationCoordinator = createRelayPlaybackRegistrationContinuationCoordinator</);

  const block = playbackHelloBlock();
  assert.match(block, /if \(!socket\.participantId\) return/);
  assert.match(block, /normalizePlaybackTransportId\(payload\.playbackTransportId\)/);
  assert.match(block, /normalizePlaybackGeneration\(payload\.playbackGeneration\)/);
  assert.match(block, /Invalid playback transport identity/);
  assert.match(block, /playbackTransport\.register\(socket,/);
  assert.match(block, /playbackRegistrationContinuationCoordinator\.continueRegistration\(\{/);
  assert.doesNotMatch(block, /type: 'playback-registered'/);
  assert.doesNotMatch(block, /youtubeTimeline\.handoffPlanForTarget/);
  assert.doesNotMatch(block, /roomSongCommands\.pendingForTarget/);
});

test('server composition retains registration continuation delivery effects', () => {
  assert.match(server, /sendRegistered: \(socket, identity\) => \{/);
  assert.match(server, /type: 'playback-registered'/);
  assert.match(server, /playbackTransportId: identity\.transportId/);
  assert.match(server, /playbackGeneration: identity\.generation/);
  assert.match(server, /sendRoomStatus: \(socket\) => sendJson\(socket, youtubeTimeline\.roomStatusPayload\(\)\)/);
  assert.match(server, /sendCommandStatus: \(socket\) => sendJson\(socket, roomSongCommandStatusPayload\(\)\)/);
  assert.match(server, /handoffPlanForTarget: \(identity\) => youtubeTimeline\.handoffPlanForTarget\(identity\)/);
  assert.match(server, /sendHandoffPrepare: \(plan\) => \{ sendHandoffPlan\('song-handoff-prepare', plan\); \}/);
  assert.match(server, /now: \(\) => performance\.now\(\)/);
  assert.match(server, /pendingCommandForTarget: \(identity, nowMs\) => roomSongCommands\.pendingForTarget\(identity, nowMs\)/);
  assert.match(server, /sendCommandApply: \(identity, command\) => playbackTransport\.send\(identity, roomSongCommandApplyPayload\(command\)\)/);
});

test('registration continuation coordinator owns no playback, song or command runtime authority', () => {
  assert.doesNotMatch(
    coordinator,
    /from '\.\/(?:playback-transport-runtime|song-session|room-song-command-runtime|room-song-command-session)\.js'/,
  );
  assert.doesNotMatch(
    coordinator,
    /PlaybackTransportRuntime|SongSession|RoomSongCommandRuntime|normalizePlaybackTransportId|normalizePlaybackGeneration|register\(/,
  );
});
