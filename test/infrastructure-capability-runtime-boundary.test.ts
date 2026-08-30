import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('server delegates infrastructure security state without moving domain effects', async () => {
  const [server, runtime] = await Promise.all([
    readFile(new URL('../src/server.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/infrastructure-capability-runtime.ts', import.meta.url), 'utf8'),
  ]);

  assert.match(server, /new InfrastructureCapabilityRuntime<RelaySocket>\(/);
  assert.match(server, /infrastructureCapability\.authenticate\(socket, payload\.key\)/);
  assert.match(server, /infrastructureCapability\.authorized\(socket\)/);
  assert.match(server, /infrastructureCapability\.authenticated\(socket\)/);
  assert.doesNotMatch(server, /socket\.infrastructureAuthenticated/);
  assert.doesNotMatch(server, /function infrastructureAuthorized/);
  assert.doesNotMatch(server, /function legacyTestInfrastructureEnabled/);

  assert.match(
    server,
    /function rejectInfrastructure[\s\S]*sendJson\(socket, \{ type: 'infrastructure-auth-rejected'[\s\S]*socket\.close\(1008/,
    'protocol rejection and socket-close side effects must remain server-owned',
  );

  assert.doesNotMatch(
    runtime,
    /BackingRuntime|SourceRuntime|MicRuntime|ParticipantSession|SongSession|sendJson|broadcastJson|\.close\(|WebSocket/,
    'capability runtime must remain independent from domain and transport effects',
  );
});
