import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const coordinator = readFileSync(
  new URL('../src/relay-take-command-coordinator.ts', import.meta.url),
  'utf8',
);

function commandBlock(name: 'startTake' | 'stopTake', next: string) {
  const command = server.indexOf('const commandProtocol = createRelayCommandProtocol<RelaySocket>({');
  const start = server.indexOf(`  ${name}: (socket`, command);
  const end = server.indexOf(`\n  },\n  ${next}:`, start);
  assert.ok(command >= 0 && start > command && end > start, `${name} block must remain identifiable`);
  return server.slice(start, end);
}

test('server keeps Take command admission authority and delegates admitted ordering', () => {
  assert.match(
    server,
    /import \{ createRelayTakeCommandCoordinator \} from '\.\/relay-take-command-coordinator\.js';/,
  );
  assert.match(
    server,
    /const takeCommandCoordinator = createRelayTakeCommandCoordinator<\s*RelaySocket,/,
  );

  const start = commandBlock('startTake', 'stopTake');
  assert.match(start, /if \(!socket\.participantId\)/);
  assert.match(start, /productStatusPayload\(nowMs\)/);
  assert.match(start, /actions\.canStartTake/);
  assert.match(start, /rejectTakeCommand\(socket, 'start'/);
  assert.match(start, /takeCommandCoordinator\.start\(\{/);
  assert.doesNotMatch(start, /takeController\.start\(/);
  assert.doesNotMatch(start, /takeFrameBoundary\(/);
  assert.doesNotMatch(start, /takeSongSnapshot\(/);

  const stop = commandBlock('stopTake', 'releaseMic');
  assert.match(stop, /if \(!socket\.participantId\)/);
  assert.match(stop, /TAKE_ID_PATTERN\.test\(takeId\)/);
  assert.match(stop, /rejectTakeCommand\(socket, 'stop'/);
  assert.match(stop, /takeCommandCoordinator\.stop\(\{/);
  assert.doesNotMatch(stop, /takeController\.stop\(/);
  assert.doesNotMatch(stop, /takeFrameBoundary\(/);
});

test('server composition retains TakeController and recording-domain effects', () => {
  assert.match(server, /frameBoundary: \(nowMs\) => takeFrameBoundary\(nowMs\)/);
  assert.match(server, /songSnapshot: \(atMs\) => takeSongSnapshot\(atMs\)/);
  assert.match(
    server,
    /cancelActiveContentValidation: \(nowMs\) => cancelActiveContentValidation\(nowMs\)/,
  );
  assert.match(server, /reportTimingStatus: \(\) => broadcastJson\(timingCalibrationStatusPayload\(\)\)/);
  assert.match(server, /startTake: \(participantId, song, position, wallClockMs\) =>\s*takeController\.start\(participantId, song, position, wallClockMs\)/);
  assert.match(server, /stopTake: \(takeId, participantId, position, reason, wallClockMs\) =>\s*takeController\.stop\(takeId, participantId, position, reason, wallClockMs\)/);
  assert.match(server, /reject: \(socket, command, reason\) => rejectTakeCommand\(socket, command, reason\)/);
  assert.match(server, /type: 'take-command-accepted'/);
});

test('Take command coordinator owns no TakeController, product or participant authority', () => {
  assert.doesNotMatch(
    coordinator,
    /from '\.\/(?:take-controller|participant-session|product-view-model|audio-session)\.js'/,
  );
  assert.doesNotMatch(
    coordinator,
    /TakeController|ParticipantSession|productStatusPayload|canStartTake|TAKE_ID_PATTERN/,
  );
});
