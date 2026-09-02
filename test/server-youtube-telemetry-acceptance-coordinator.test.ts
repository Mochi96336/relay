import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
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
    /youtubeTelemetryAcceptanceCoordinator\.accept\(\{[\s\S]*socket,[\s\S]*acceptedIdentity,[\s\S]*nowMs,[\s\S]*timelineStatus,[\s\S]*completesCommandId: commandGate\.completesCommandId,[\s\S]*handoffCompleted: result\.handoffCompleted,[\s\S]*handoffId: result\.handoffId,[\s\S]*previousLeader: result\.previousLeader,[\s\S]*\}\);/,
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
    /import \{ createRelayYoutubeTelemetryAcceptanceCoordinator \} from '\.\/relay-youtube-telemetry-acceptance-coordinator\.js';/,
  );
  assert.match(
    server,
    /const youtubeTelemetryAcceptanceCoordinator = createRelayYoutubeTelemetryAcceptanceCoordinator</,
  );
  assert.match(server, /registerPlayback: \(socket, identity\) => \{ playbackTransport\.register\(socket, identity\); \}/);
  assert.match(server, /clearTelemetryRejection: \(socket\) => \{ socket\.telemetryRejectedReason = undefined; \}/);
  assert.match(server, /cancelActiveContentValidation: \(nowMs\) => cancelActiveContentValidation\(nowMs\)/);
  assert.match(server, /reportTimingStatus: \(\) => broadcastJson\(timingCalibrationStatusPayload\(\)\)/);
  assert.match(server, /reportTimelineStatus: \(status\) => broadcastJson\(status\)/);
  assert.match(server, /reportRoomStatus: \(nowMs\) => broadcastJson\(youtubeTimeline\.roomStatusPayload\(nowMs\)\)/);
  assert.match(server, /completeRoomSongCommand: \(commandId\) => roomSongCommands\.complete\(commandId\)/);
  assert.match(server, /type: 'room-song-command-complete'/);
  assert.match(server, /revision: roomSongCommands\.revision/);
  assert.match(server, /reportRoomSongCommandStatus: \(nowMs\) => broadcastJson\(roomSongCommandStatusPayload\(nowMs\)\)/);
  assert.match(server, /type: 'song-handoff-release'/);
  assert.match(server, /type: 'song-handoff-complete'/);
});

test('accepted YouTube telemetry coordinator owns ordering only, not runtime authority', () => {
  assert.doesNotMatch(coordinator, /^import /m);
  assert.doesNotMatch(
    coordinator,
    /\bplaybackTransport\.|\byoutubeTimeline\.|\broomSongCommands\.|\bcontentCalibrationValidator\.|\bcalibration\.|\btimingRuntime\.|\bbroadcastJson\b/,
  );
});
