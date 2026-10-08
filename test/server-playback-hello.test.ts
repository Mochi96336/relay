import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');

function playbackHelloBlock() {
  const command = server.indexOf('const commandProtocol = createRelayCommandProtocol<RelaySocket>({');
  const start = server.indexOf('  playbackHello: (socket, payload) => {', command);
  const end = server.indexOf('\n  },\n  youtubeTelemetry:', start);
  assert.ok(command >= 0 && start > command && end > start, 'playbackHello block must remain identifiable');
  return server.slice(start, end);
}

test('server retains playback identity validation and registration authority', () => {
  const block = playbackHelloBlock();
  assert.match(block, /if \(!socket\.participantId\) return/);
  assert.match(block, /normalizePlaybackTransportId\(payload\.playbackTransportId\)/);
  assert.match(block, /normalizePlaybackGeneration\(payload\.playbackGeneration\)/);
  assert.match(block, /Invalid playback transport identity/);
  assert.match(block, /playbackTransport\.register\(socket,/);
  assert.match(block, /playbackRegistered\(socket, playbackIdentity\)/);
  assert.doesNotMatch(block, /type: 'playback-registered'/);
  assert.doesNotMatch(block, /youtubeTimeline\.handoffPlanForTarget/);
  assert.doesNotMatch(block, /roomSongCommands\.pendingForTarget/);
});
