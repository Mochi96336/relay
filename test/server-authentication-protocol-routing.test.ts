import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const protocol = readFileSync(new URL('../src/relay-authentication-protocol.ts', import.meta.url), 'utf8');

test('server delegates authentication message selection through its own seam', () => {
  assert.match(server, /createRelayAuthenticationProtocol<RelaySocket>/);
  assert.match(server, /authenticationProtocol\.dispatch\(socket, payload\)/);
  assert.match(protocol, /case 'infrastructure-authenticate'/);
  assert.match(protocol, /case 'participant-authenticate'/);
  assert.doesNotMatch(server, /payload\.type === 'infrastructure-authenticate'/);
  assert.doesNotMatch(server, /payload\.type === 'participant-authenticate'/);
});

test('server still owns authentication authority and transport effects', () => {
  assert.match(server, /infrastructureCapability\.authenticate\(socket, payload\.key\)/);
  assert.match(server, /rejectInfrastructure\(/);
  assert.match(server, /type: 'infrastructure-authenticated'/);

  assert.match(server, /participantIdentityFromAuthentication\(payload\)/);
  assert.match(server, /authenticated\.kind !== 'valid'/);
  assert.match(server, /infrastructureCapability\.authenticated\(socket\)/);
  assert.match(server, /socket\.participantId !== undefined && socket\.participantId !== authenticated\.participantId/);
  assert.match(server, /type: 'participant-auth-rejected'/);
  assert.match(server, /socket\.close\(1008, 'Participant capability mismatch\.'\)/);
  assert.match(server, /attachParticipantIdentity\(socket, authenticated\)/);
  assert.match(server, /type: 'participant-authenticated'/);

  assert.doesNotMatch(
    protocol,
    /InfrastructureCapability|ParticipantSession|participantIdentityFromAuthentication|attachParticipantIdentity|sendJson|\.close\(|capability/i,
  );
});

test('registration and Robot lifecycle authority remain inline after auth extraction', () => {
  assert.match(server, /payload\.type === 'register'/);
  assert.match(server, /payload\.type === 'robot-source-hello'/);
});
