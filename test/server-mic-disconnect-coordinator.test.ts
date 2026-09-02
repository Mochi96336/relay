import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const coordinator = readFileSync(
  new URL('../src/relay-mic-disconnect-coordinator.ts', import.meta.url),
  'utf8',
);

test('server delegates only Mic disconnect ordering through the coordinator seam', () => {
  assert.match(server, /createRelayMicDisconnectCoordinator<RelaySocket>/);
  assert.match(server, /micDisconnectCoordinator\.handle\(socket\)/);
  assert.doesNotMatch(server, /if \(micRuntime\.isPublisher\(socket\)\) \{\s*takeController\.noteQualityEvent\('mic-transport-disconnected'\)/);
});

test('server composition retains Mic disconnect authority and domain effects', () => {
  assert.match(server, /isPublisher: \(socket\) => micRuntime\.isPublisher\(socket\)/);
  assert.match(server, /noteDisconnected: \(\) => takeController\.noteQualityEvent\('mic-transport-disconnected'\)/);
  assert.match(server, /socket\.participantId\s*&& participants\.micOwnerId === socket\.participantId/);
  assert.match(server, /detachPublisher: \(socket\) => micRuntime\.detachPublisher\(socket\)/);
  assert.match(server, /clearMediaAuthority: \(\) => clearMicMediaAuthority\(\)/);
  assert.match(server, /const directMediaStillLive = webTransportMicConnected\(\)/);
  assert.match(server, /session\.setMicExpected\(directMediaStillLive\)/);
  assert.match(server, /micTransportGrace\.schedule\(ownerId\)/);
  assert.match(server, /maybeStopLiveSourceWhenUnarmed: \(\) => maybeStopLiveSourceWhenUnarmed\(\)/);
  assert.match(server, /calibration\.collecting/);
  assert.match(server, /calibration\.fail\('Microphone disconnected during calibration\.'\)/);
  assert.match(server, /cancelActiveContentValidation\(\)/);
  assert.match(server, /broadcastJson\(timingCalibrationStatusPayload\(\)\)/);
  assert.match(server, /reportStatus: \(\) => broadcastStatus\(\)/);

  assert.doesNotMatch(
    coordinator,
    /MicRuntime|ParticipantSession|MicTransportGraceRuntime|CalibrationSession|ContentCalibrationValidator|AudioSession|micRuntime|participants|micTransportGrace|clearMicMediaAuthority|webTransportMicConnected|session\.setMicExpected|calibration\.(?:collecting|fail)|cancelActiveContentValidation|broadcastJson|broadcastStatus/,
  );
});

test('socket close retains replacement fence plus Robot, Backing and participant composition', () => {
  const closeStart = server.indexOf("socket.on('close', () => {");
  assert.ok(closeStart >= 0);
  const closeEnd = server.indexOf("\n  });\n});\n\nwss.on('close'", closeStart);
  assert.ok(closeEnd > closeStart);
  const close = server.slice(closeStart, closeEnd);

  assert.match(close, /if \(!socket\.replaced\) \{/);
  assert.match(close, /robotDisconnectCoordinator\.handle\(socket\)/);
  assert.match(close, /micDisconnectCoordinator\.handle\(socket\)/);
  assert.match(close, /backingDisconnectCoordinator\.handle\(socket\)/);
  assert.match(close, /participants\.detach\(socket\.participantConnectionId, Date\.now\(\)\)/);
});
