import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const protocol = readFileSync(new URL('../src/relay-command-protocol.ts', import.meta.url), 'utf8');

test('server delegates the extracted low-risk mutating commands through the command protocol seam', () => {
  assert.match(server, /createRelayCommandProtocol<RelaySocket>/);
  assert.match(server, /commandProtocol\.dispatch\(socket, payload\)/);
  assert.match(protocol, /case 'participant-rename'/);
  assert.match(protocol, /case 'acquire-mic'/);
  assert.match(protocol, /case 'force-acquire-mic'/);
  assert.match(protocol, /case 'playback-mic-intent'/);

  assert.doesNotMatch(server, /payload\.type === 'participant-rename'/);
  assert.doesNotMatch(server, /payload\.type === 'acquire-mic'/);
  assert.doesNotMatch(server, /payload\.type === 'force-acquire-mic'/);
  assert.doesNotMatch(server, /payload\.type === 'playback-mic-intent'/);
});

test('the server composition boundary still owns the extracted command effects', () => {
  assert.match(server, /participants\.rename\(socket\.participantId, payload\.nickname, Date\.now\(\)\)/);
  assert.match(server, /Microphone ownership is committed by publisher registration/);
  assert.match(server, /playbackTransport\.noteMicIntent\(socket, performance\.now\(\)\)/);
  assert.doesNotMatch(protocol, /ParticipantSession|PlaybackTransportRuntime|sendJson|performance\.now/);
});

test('high-risk command authority remains inline for later extractions', () => {
  assert.match(server, /payload\.type === 'start-take'/);
  assert.match(server, /payload\.type === 'release-mic'/);
  assert.match(server, /payload\.type === 'room-song-command'/);
  assert.match(server, /payload\.type === 'register'/);
  assert.match(server, /payload\.type === 'robot-source-hello'/);
});
