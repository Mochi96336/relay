import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const coordinator = readFileSync(new URL('../src/relay-song-handoff-result-coordinator.ts', import.meta.url), 'utf8');

function commandBlock(name: 'songHandoffReady' | 'songHandoffFailed', next: string) {
  const start = server.indexOf(`  ${name}: (socket, payload) => {`);
  const end = server.indexOf(`\n  ${next}:`, start);
  assert.ok(start >= 0 && end > start, `${name} block must remain identifiable`);
  return server.slice(start, end);
}

test('server keeps playback identity authority and delegates handoff result ordering', () => {
  const ready = commandBlock('songHandoffReady', 'songHandoffFailed');
  const failed = commandBlock('songHandoffFailed', 'participantRename');

  for (const block of [ready, failed]) {
    assert.match(block, /playbackTransport\.identity\(socket\)/);
    assert.match(block, /if \(!playbackIdentity\) return/);
  }

  assert.match(ready, /songHandoffResultCoordinator\.ready\(\{/);
  assert.match(ready, /micOwnerId: participants\.micOwnerId/);
  assert.doesNotMatch(ready, /youtubeTimeline\.markHandoffReady|sendHandoffPlan|broadcastJson/);

  assert.match(failed, /songHandoffResultCoordinator\.failed\(\{/);
  assert.doesNotMatch(failed, /youtubeTimeline\.deferHandoff|broadcastJson/);
});

test('server composition retains SongSession authority and delivery effects', () => {
  assert.match(
    server,
    /import \{ createRelaySongHandoffResultCoordinator \} from '\.\/relay-song-handoff-result-coordinator\.js';/,
  );
  assert.match(server, /const songHandoffResultCoordinator = createRelaySongHandoffResultCoordinator/);
  assert.match(
    server,
    /markReady: \(identity, handoffId, micOwnerId\) => youtubeTimeline\.markHandoffReady\(identity, handoffId, micOwnerId\)/,
  );
  assert.match(server, /defer: \(identity, handoffId\) => youtubeTimeline\.deferHandoff\(identity, handoffId\)/);
  assert.match(server, /sendCommit: \(plan\) => \{ sendHandoffPlan\('song-handoff-commit', plan\); \}/);
  assert.match(server, /reportTimelineStatus: \(\) => broadcastJson\(youtubeTimeline\.statusPayload\(\)\)/);
  assert.match(server, /reportRoomStatus: \(\) => broadcastJson\(youtubeTimeline\.roomStatusPayload\(\)\)/);
});

test('song handoff result coordinator owns no playback or SongSession runtime authority', () => {
  assert.doesNotMatch(coordinator, /^import\s+.*(?:playback-transport-runtime|song-session)/m);
  assert.doesNotMatch(coordinator, /\byoutubeTimeline\.|\bplaybackTransport\./);
});
