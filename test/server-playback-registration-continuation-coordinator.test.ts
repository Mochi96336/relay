import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseTypeScriptSource, variableInitializerCode } from './support/source-contract.js';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const lifecycle = parseTypeScriptSource(new URL('../src/relay-song-orchestration.ts', import.meta.url),
  readFileSync(new URL('../src/relay-song-orchestration.ts', import.meta.url), 'utf8'));
const serverSource = parseTypeScriptSource(new URL('../src/server.ts', import.meta.url), server);
const composition = variableInitializerCode(lifecycle, 'registration');
const binding = variableInitializerCode(serverSource, 'relaySongLifecycle');

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
    /import \{ createRelaySongCommandOrchestration, createRelaySongLifecycle \} from '\.\/relay-song-orchestration\.js';/,
  );
  assert.match(server, /const relaySongLifecycle = createRelaySongLifecycle</);

  const block = playbackHelloBlock();
  assert.match(block, /if \(!socket\.participantId\) return/);
  assert.match(block, /normalizePlaybackTransportId\(payload\.playbackTransportId\)/);
  assert.match(block, /normalizePlaybackGeneration\(payload\.playbackGeneration\)/);
  assert.match(block, /Invalid playback transport identity/);
  assert.match(block, /playbackTransport\.register\(socket,/);
  assert.match(block, /relaySongLifecycle\.continueRegistration\(\{/);
  assert.doesNotMatch(block, /type: 'playback-registered'/);
  assert.doesNotMatch(block, /youtubeTimeline\.handoffPlanForTarget/);
  assert.doesNotMatch(block, /roomSongCommands\.pendingForTarget/);
});

test('server composition retains registration continuation delivery effects', () => {
  assert.match(binding, /song: youtubeTimeline/);
  assert.match(binding, /commands: roomSongCommands/);
  assert.match(binding, /playback: playbackTransport/);
  assert.match(binding, /commandOrchestration: relaySongCommands/);
  assert.match(binding, /commandStatusPayload: roomSongCommandStatusPayload/);
  assert.match(binding, /send: sendJson/);
  assert.match(binding, /now: \(\) => performance\.now\(\)/);
  assert.match(composition, /^createRelayPlaybackRegistrationContinuationCoordinator/);
  assert.match(composition, /sendRegistered: \(socket, identity\) => \{/);
  assert.match(composition, /type: 'playback-registered'/);
  assert.match(composition, /playbackTransportId: identity\.transportId/);
  assert.match(composition, /playbackGeneration: identity\.generation/);
  assert.match(composition, /sendRoomStatus: \(socket\) => effects\.send\(socket, song\.roomStatusPayload\(\)\)/);
  assert.match(composition, /sendCommandStatus: \(socket\) => effects\.send\(socket, queries\.commandStatusPayload\(\)\)/);
  assert.match(composition, /handoffPlanForTarget: \(identity\) => song\.handoffPlanForTarget\(identity\)/);
  assert.match(composition, /sendHandoffPrepare: \(plan\) => \{ sendHandoffPlan\('song-handoff-prepare', plan\); \}/);
  assert.match(composition, /now: \(\) => clock\.now\(\)/);
  assert.match(composition, /pendingCommandForTarget: \(identity, nowMs\) => commands\.pendingForTarget\(identity, nowMs\)/);
  assert.match(composition, /sendCommandApply: \(identity, command\) => playback\.send\(identity, commandOrchestration\.applyPayload\(command\)\)/);
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
