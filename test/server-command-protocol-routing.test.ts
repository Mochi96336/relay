import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const protocol = readFileSync(new URL('../src/relay-command-protocol.ts', import.meta.url), 'utf8');

test('server delegates the extracted low-risk mutating commands through the command protocol seam', () => {
  assert.match(server, /createRelayCommandProtocol<RelaySocket>/);
  assert.match(server, /commandProtocol\.dispatch\(socket, payload\)/);
  assert.match(protocol, /case 'start-take'/);
  assert.match(protocol, /case 'stop-take'/);
  assert.match(protocol, /case 'release-mic'/);
  assert.match(protocol, /case 'room-song-command'/);
  assert.match(protocol, /case 'room-song-command-failed'/);
  assert.match(protocol, /case 'participant-rename'/);
  assert.match(protocol, /case 'acquire-mic'/);
  assert.match(protocol, /case 'force-acquire-mic'/);
  assert.match(protocol, /case 'playback-mic-intent'/);

  assert.doesNotMatch(server, /payload\.type === 'start-take'/);
  assert.doesNotMatch(server, /payload\.type === 'stop-take'/);
  assert.doesNotMatch(server, /payload\.type === 'release-mic'/);
  assert.doesNotMatch(server, /payload\.type === 'room-song-command'/);
  assert.doesNotMatch(server, /payload\.type === 'room-song-command-failed'/);
  assert.doesNotMatch(server, /payload\.type === 'participant-rename'/);
  assert.doesNotMatch(server, /payload\.type === 'acquire-mic'/);
  assert.doesNotMatch(server, /payload\.type === 'force-acquire-mic'/);
  assert.doesNotMatch(server, /payload\.type === 'playback-mic-intent'/);
});

test('the server composition boundary still owns the extracted command effects', () => {
  assert.match(server, /takeController\.start\(/);
  assert.match(server, /takeController\.stop\(/);
  assert.match(server, /takeFrameBoundary\(nowMs\)/);
  assert.match(server, /productStatusPayload\(nowMs\)/);
  assert.match(server, /participants\.releaseMic\(socket\.participantId\)/);
  assert.match(server, /applyMicOwnerEffects\(result\.effects, performance\.now\(\)/);
  assert.match(server, /revokePublisherTransport\('You released the microphone\.'\)/);
  assert.match(server, /clearMicMediaAuthority\(\)/);
  assert.match(server, /micTransportGrace\.cancel\(\)/);
  assert.match(server, /parseRoomSongCommand\(payload\)/);
  assert.match(server, /roomSongCommands\.begin\(/);
  assert.match(server, /playbackTransport\.identity\(socket\)/);
  assert.match(server, /playbackTransport\.send\(commandTarget, roomSongCommandApplyPayload\(decision\.command\)\)/);
  assert.match(server, /rejectRoomSongCommand\(/);
  assert.match(server, /broadcastJson\(roomSongCommandStatusPayload\(nowMs\)\)/);
  assert.match(server, /roomSongCommands\.pendingForTarget\(playbackIdentity, nowMs\)/);
  assert.match(server, /roomSongCommands\.fail\(playbackIdentity, pendingCommand\.commandId\)/);
  assert.match(server, /broadcastRoomSongCommandFailure\(pendingCommand\.commandId, 'playback-failed', nowMs\)/);
  assert.match(server, /participants\.rename\(socket\.participantId, payload\.nickname, Date\.now\(\)\)/);
  assert.match(server, /Microphone ownership is committed by publisher registration/);
  assert.match(server, /playbackTransport\.noteMicIntent\(socket, performance\.now\(\)\)/);
  assert.doesNotMatch(protocol, /ParticipantSession|PlaybackTransportRuntime|sendJson|performance\.now/);
});

test('remaining high-risk command authority stays inline for later extractions', () => {
  assert.match(server, /payload\.type === 'register'/);
  assert.match(server, /payload\.type === 'robot-source-hello'/);
});
