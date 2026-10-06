import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseTypeScriptSource, variableInitializerCode } from './support/source-contract.js';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const lifecycle = parseTypeScriptSource(new URL('../src/relay-song-orchestration.ts', import.meta.url),
  readFileSync(new URL('../src/relay-song-orchestration.ts', import.meta.url), 'utf8'));
const serverSource = parseTypeScriptSource(new URL('../src/server.ts', import.meta.url), server);
const composition = variableInitializerCode(lifecycle, 'telemetry');
const binding = variableInitializerCode(serverSource, 'relaySongLifecycle');

const coordinator = readFileSync(
  new URL('../src/relay-youtube-telemetry-acceptance-coordinator.ts', import.meta.url),
  'utf8',
);

function youtubeTelemetryBlock() {
  const start = server.indexOf('  youtubeTelemetry: (socket, payload) => {');
  const end = server.indexOf('\n\n  setVocalFineTune:', start);
  assert.ok(start >= 0 && end > start);
  return server.slice(start, end);
}

test('YouTube telemetry keeps identity, command gate and SongSession update authority in server', () => {
  const block = youtubeTelemetryBlock();
  assert.match(block, /playbackTransport\.identity\(socket\)/);
  assert.match(block, /roomSongCommands\.gateTelemetry\(/);
  assert.match(block, /const result = youtubeTimeline\.update\(/);
  assert.match(block, /if \(result\.accepted\) \{/);
  assert.match(block, /const timelineStatus = youtubeTimeline\.statusPayload\(nowMs\);/);
  assert.match(
    block,
    /relaySongLifecycle\.acceptTelemetry\(\{[\s\S]*socket,[\s\S]*acceptedIdentity,[\s\S]*nowMs,[\s\S]*timelineStatus,[\s\S]*completesCommandId: commandGate\.completesCommandId,[\s\S]*handoffCompleted: result\.handoffCompleted,[\s\S]*handoffId: result\.handoffId,[\s\S]*previousLeader: result\.previousLeader,[\s\S]*\}\);/,
  );

  const acceptedStart = block.indexOf('if (result.accepted) {');
  const acceptedEnd = block.indexOf('} else {', acceptedStart);
  assert.ok(acceptedStart >= 0 && acceptedEnd > acceptedStart);
  const accepted = block.slice(acceptedStart, acceptedEnd);
  assert.doesNotMatch(accepted, /playbackTransport\.register\(/);
  assert.doesNotMatch(accepted, /cancelActiveContentValidation\(/);
  assert.doesNotMatch(accepted, /roomSongCommands\.complete\(/);
  assert.doesNotMatch(accepted, /playbackTransport\.send\(/);
  assert.doesNotMatch(accepted, /broadcastJson\(/);
});

test('server composition retains every accepted YouTube telemetry domain effect', () => {
  assert.match(
    server,
    /import \{ createRelaySongCommandOrchestration, createRelaySongLifecycle \} from '\.\/relay-song-orchestration\.js';/,
  );
  assert.match(
    server,
    /const relaySongLifecycle = createRelaySongLifecycle</,
  );
  assert.match(binding, /song: youtubeTimeline/);
  assert.match(binding, /commands: roomSongCommands/);
  assert.match(binding, /playback: playbackTransport/);
  assert.match(binding, /commandStatusPayload: roomSongCommandStatusPayload/);
  assert.match(binding, /send: sendJson/);
  assert.match(binding, /broadcast: broadcastJson/);
  assert.match(binding, /crossCommands: \{ cancelActiveContentValidation, revokeContentMappingOnRateChange \}/);
  assert.match(binding, /reportTimingStatus: \(\) => broadcastJson\(timingCalibrationStatusPayload\(\)\)/);
  assert.match(composition, /^createRelayYoutubeTelemetryAcceptanceCoordinator/);
  assert.match(composition, /reportTimelineStatus: \(status\) => effects\.reportAcceptedTimelineStatus\(status\)/);
  assert.match(composition, /registerPlayback: \(socket, identity\) => \{ playback\.register\(socket, identity\); \}/);
  assert.match(composition, /clearTelemetryRejection: \(socket\) => \{ socket\.telemetryRejectedReason = undefined; \}/);
  assert.match(composition, /cancelActiveContentValidation: \(nowMs\) => crossCommands\.cancelActiveContentValidation\(nowMs\)/);
  assert.match(composition, /reportTimingStatus: \(\) => effects\.reportTimingStatus\(\)/);
  assert.match(
    server,
    /reportAcceptedTimelineStatus: \(status\) => \{\s*lastTelemetryTimelineBroadcastAtMs = performance\.now\(\);\s*broadcastJson\(status\);\s*\}/,
    'an accepted telemetry snapshot is broadcast, and tells the room timer it need not repeat it',
  );
  assert.match(composition, /reportRoomStatus: \(nowMs\) => effects\.broadcast\(song\.roomStatusPayload\(nowMs\)\)/);
  assert.match(composition, /completeRoomSongCommand: \(commandId\) => commands\.complete\(commandId\)/);
  assert.match(composition, /type: 'room-song-command-complete'/);
  assert.match(composition, /revision: commands\.revision/);
  assert.match(composition, /reportRoomSongCommandStatus: \(nowMs\) => effects\.broadcast\(queries\.commandStatusPayload\(nowMs\)\)/);
  assert.match(composition, /type: 'song-handoff-release'/);
  assert.match(composition, /type: 'song-handoff-complete'/);
});

test('accepted YouTube telemetry coordinator owns ordering only, not runtime authority', () => {
  assert.doesNotMatch(coordinator, /^import /m);
  assert.doesNotMatch(
    coordinator,
    /\bplaybackTransport\.|\byoutubeTimeline\.|\broomSongCommands\.|\bcontentCalibrationValidator\.|\bcalibration\.|\btimingRuntime\.|\bbroadcastJson\b/,
  );
});
