import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const coordinator = readFileSync(
  new URL('../src/relay-mic-release-coordinator.ts', import.meta.url),
  'utf8',
);

function releaseMicBlock() {
  const command = server.indexOf('const commandProtocol = createRelayCommandProtocol<RelaySocket>({');
  const start = server.indexOf('releaseMic: (socket) => {', command);
  const end = server.indexOf('\n  },\n  roomSongCommand:', start);
  assert.ok(command >= 0 && start > command && end > start);
  return server.slice(start, end);
}

test('Mic release keeps ParticipantSession lease authority in server', () => {
  const release = releaseMicBlock();
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
  assert.match(
    server,
    /import \{ createRelayMicReleaseCoordinator \} from '\.\/relay-mic-release-coordinator\.js';/,
  );
  assert.match(server, /const micReleaseCoordinator = createRelayMicReleaseCoordinator</);
  assert.match(server, /publisherParticipantId: \(\) => micRuntime\.publisher\?\.participantId \?\? null/);
  assert.match(server, /mediaOwnerId: \(\) => micRuntime\.mediaOwnerId/);
  assert.match(server, /revokePublisherTransport: \(message\) => revokePublisherTransport\(message\)/);
  assert.match(server, /clearMediaAuthority: \(\) => clearMicMediaAuthority\(\)/);
  assert.match(server, /cancelTransportGrace: \(\) => micTransportGrace\.cancel\(\)/);
  assert.match(server, /applyOwnershipEffects: \(effects, hooks\) => \{/);
  assert.match(server, /applyMicOwnerEffects\(effects, performance\.now\(\), \{/);
  assert.match(server, /afterQualityEvent: hooks\.afterQualityEvent/);
  assert.match(server, /beforeTimingInvalidation: hooks\.beforeTimingInvalidation/);
  assert.match(server, /broadcastSessionStatus: \(\) => broadcastSessionStatus\(\)/);
  assert.match(server, /sendReleased: \(socket\) => sendJson\(socket, \{ type: 'mic-released' \}\)/);
});

test('Mic release coordinator owns ordering only, not participant or media authority', () => {
  assert.doesNotMatch(coordinator, /^import /m);
  assert.doesNotMatch(
    coordinator,
    /new ParticipantSession|new MicRuntime|new MicTransportGraceRuntime|participants\.|micRuntime\.|takeController\.|sendJson|broadcastJson/,
  );
});
