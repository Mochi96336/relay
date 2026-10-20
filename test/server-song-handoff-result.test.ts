import assert from 'node:assert/strict';
import test from 'node:test';

import { objectArrowCallbackCode, readSourceContract } from './support/source-contract.js';

const server = readSourceContract('src/server.ts');

test('server keeps playback identity authority and leaves the handoff result to its functions', () => {
  const ready = objectArrowCallbackCode(server, 'commandProtocol', 'songHandoffReady');
  const failed = objectArrowCallbackCode(server, 'commandProtocol', 'songHandoffFailed');

  for (const block of [ready, failed]) {
    assert.match(block, /playbackTransport\.identity\(socket\)/);
    assert.match(block, /if \(!playbackIdentity\) return/);
  }

  assert.match(ready, /songHandoffReady\(playbackIdentity, payload\.handoffId\)/);
  assert.doesNotMatch(ready, /youtubeTimeline\.markHandoffReady|sendHandoffPlan|broadcastJson/);

  assert.match(failed, /songHandoffFailed\(playbackIdentity, payload\.handoffId\)/);
  assert.doesNotMatch(failed, /youtubeTimeline\.deferHandoff|broadcastJson/);
});
