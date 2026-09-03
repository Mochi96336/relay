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
  new URL('../src/relay-mic-release-coordinator.ts', import.meta.url),
  readFileSync(new URL('../src/relay-mic-release-coordinator.ts', import.meta.url), 'utf8'),
);

test('Mic release keeps ParticipantSession lease authority in server', () => {
  const release = objectArrowCallbackCode(server, 'commandProtocol', 'releaseMic');
  assert.match(release, /if \(!socket\.participantId\) return/);
  assert.match(release, /participants\.releaseMic\(socket\.participantId\)/);
  assert.match(release, /if \(!result\.ok\) return/);
  assert.match(
    release,
    /micReleaseCoordinator\.release\(\{[\s\S]*socket,[\s\S]*participantId: socket\.participantId,[\s\S]*effects: result\.effects,[\s\S]*\}\)/,
  );

  assert.doesNotMatch(release, /micRuntime\./);
  assert.doesNotMatch(release, /revokePublisherTransport\(/);
  assert.doesNotMatch(release, /clearMicMediaAuthority\(/);
  assert.doesNotMatch(release, /micTransportGrace\.cancel\(/);
  assert.doesNotMatch(release, /applyMicOwnerEffects\(/);
  assert.doesNotMatch(release, /broadcastSessionStatus\(/);
  assert.doesNotMatch(release, /sendJson\(/);
});

test('server composition retains Mic transport, timing, session, and ack effects', () => {
  assert.ok(importSources(server).includes('./relay-mic-release-coordinator.js'));
  const composition = variableInitializerCode(server, 'micReleaseCoordinator');
  assert.match(composition, /^createRelayMicReleaseCoordinator/);
  assert.match(composition, /publisherParticipantId: \(\) => micRuntime\.publisher\?\.participantId \?\? null/);
  assert.match(composition, /mediaOwnerId: \(\) => micRuntime\.mediaOwnerId/);
  assert.match(composition, /revokePublisherTransport: \(message\) => revokePublisherTransport\(message\)/);
  assert.match(composition, /clearMediaAuthority: \(\) => clearMicMediaAuthority\(\)/);
  assert.match(composition, /cancelTransportGrace: \(\) => micTransportGrace\.cancel\(\)/);
  assert.match(composition, /applyOwnershipEffects: \(effects, hooks\) => \{/);
  assert.match(composition, /applyMicOwnerEffects\(effects, performance\.now\(\), \{/);
  assert.match(composition, /afterQualityEvent: hooks\.afterQualityEvent/);
  assert.match(composition, /beforeTimingInvalidation: hooks\.beforeTimingInvalidation/);
  assert.match(composition, /broadcastSessionStatus: \(\) => broadcastSessionStatus\(\)/);
  assert.match(composition, /sendReleased: \(socket\) => sendJson\(socket, \{ type: 'mic-released' \}\)/);
});

test('Mic release coordinator owns ordering only, not participant or media authority', () => {
  const coordinatorCode = sourceCode(coordinator);
  assert.doesNotMatch(coordinatorCode, /^import /m);
  assert.doesNotMatch(
    coordinatorCode,
    /new ParticipantSession|new MicRuntime|new MicTransportGraceRuntime|participants\.|micRuntime\.|takeController\.|sendJson|broadcastJson/,
  );
});
