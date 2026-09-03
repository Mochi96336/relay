import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  callObjectPropertySource,
  topLevelInitializerSource,
} from './helpers/source-boundary.js';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const coordinator = readFileSync(new URL('../src/relay-song-handoff-result-coordinator.ts', import.meta.url), 'utf8');

test('server keeps playback identity authority and delegates handoff result ordering', () => {
  const ready = callObjectPropertySource(server, 'commandProtocol', 'songHandoffReady');
  const failed = callObjectPropertySource(server, 'commandProtocol', 'songHandoffFailed');

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
  const composition = topLevelInitializerSource(server, 'songHandoffResultCoordinator');
  assert.match(
    composition,
    /markReady: \(identity, handoffId, micOwnerId\) => youtubeTimeline\.markHandoffReady\(identity, handoffId, micOwnerId\)/,
  );
  assert.match(composition, /defer: \(identity, handoffId\) => youtubeTimeline\.deferHandoff\(identity, handoffId\)/);
  assert.match(composition, /sendCommit: \(plan\) => \{ sendHandoffPlan\('song-handoff-commit', plan\); \}/);
  assert.match(composition, /reportTimelineStatus: \(\) => broadcastJson\(youtubeTimeline\.statusPayload\(\)\)/);
  assert.match(composition, /reportRoomStatus: \(\) => broadcastJson\(youtubeTimeline\.roomStatusPayload\(\)\)/);
});

test('song handoff result coordinator owns no playback or SongSession runtime authority', () => {
  assert.doesNotMatch(coordinator, /^import\s+.*(?:playback-transport-runtime|song-session)/m);
  assert.doesNotMatch(coordinator, /\byoutubeTimeline\.|\bplaybackTransport\./);
});
