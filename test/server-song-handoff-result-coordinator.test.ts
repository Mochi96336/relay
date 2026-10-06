import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  importSources,
  objectArrowCallbackCode,
  parseTypeScriptSource,
  sourceCode,
  variableInitializerCode,
} from './support/source-contract.js';

const server = parseTypeScriptSource(
  new URL('../src/server.ts', import.meta.url),
  readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'),
);
const coordinator = parseTypeScriptSource(
  new URL('../src/relay-song-handoff-result-coordinator.ts', import.meta.url),
  readFileSync(new URL('../src/relay-song-handoff-result-coordinator.ts', import.meta.url), 'utf8'),
);
const lifecycle = parseTypeScriptSource(new URL('../src/relay-song-orchestration.ts', import.meta.url),
  readFileSync(new URL('../src/relay-song-orchestration.ts', import.meta.url), 'utf8'));

test('server keeps playback identity authority and delegates handoff result ordering', () => {
  const ready = objectArrowCallbackCode(server, 'commandProtocol', 'songHandoffReady');
  const failed = objectArrowCallbackCode(server, 'commandProtocol', 'songHandoffFailed');

  for (const block of [ready, failed]) {
    assert.match(block, /playbackTransport\.identity\(socket\)/);
    assert.match(block, /if \(!playbackIdentity\) return/);
  }

  assert.match(ready, /relaySongLifecycle\.ready\(\{/);
  assert.match(ready, /micOwnerId: participants\.micOwnerId/);
  assert.doesNotMatch(ready, /youtubeTimeline\.markHandoffReady|sendHandoffPlan|broadcastJson/);

  assert.match(failed, /relaySongLifecycle\.failed\(\{/);
  assert.doesNotMatch(failed, /youtubeTimeline\.deferHandoff|broadcastJson/);
});

test('server composition retains SongSession authority and delivery effects', () => {
  assert.ok(importSources(lifecycle).includes('./relay-song-handoff-result-coordinator.js'));
  const binding = variableInitializerCode(server, 'relaySongLifecycle');
  assert.match(binding, /song: youtubeTimeline/);
  assert.match(binding, /playback: playbackTransport/);
  assert.match(binding, /broadcast: broadcastJson/);
  const composition = variableInitializerCode(lifecycle, 'handoffResult');
  assert.match(composition, /^createRelaySongHandoffResultCoordinator/);
  assert.match(
    composition,
    /markReady: \(identity, handoffId, micOwnerId\) => song\.markHandoffReady\(identity, handoffId, micOwnerId\)/,
  );
  assert.match(composition, /defer: \(identity, handoffId\) => song\.deferHandoff\(identity, handoffId\)/);
  assert.match(composition, /sendCommit: \(plan\) => \{ sendHandoffPlan\('song-handoff-commit', plan\); \}/);
  assert.match(composition, /reportTimelineStatus: \(\) => effects\.broadcast\(song\.statusPayload\(\)\)/);
  assert.match(composition, /reportRoomStatus: \(\) => effects\.broadcast\(song\.roomStatusPayload\(\)\)/);
});

test('song handoff result coordinator owns no playback or SongSession runtime authority', () => {
  const coordinatorCode = sourceCode(coordinator);
  assert.doesNotMatch(coordinatorCode, /^import\s+.*(?:playback-transport-runtime|song-session)/m);
  assert.doesNotMatch(coordinatorCode, /\byoutubeTimeline\.|\bplaybackTransport\./);
});
