import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const coordinator = readFileSync(
  new URL('../src/relay-mic-disconnect-coordinator.ts', import.meta.url),
  'utf8',
);

const lifecycle = readFileSync(new URL('../src/relay-mic-lifecycle.ts', import.meta.url), 'utf8');

test('server delegates only Mic disconnect ordering through the coordinator seam', () => {
  assert.match(server, /createRelayMicLifecycle<RelaySocket>/);
  assert.match(server, /relayMicLifecycle\.disconnect\(socket\)/);
  assert.doesNotMatch(server, /if \(micRuntime\.isPublisher\(socket\)\) \{\s*takeController\.noteQualityEvent\('mic-transport-disconnected'\)/);
});

test('server composition retains Mic disconnect authority and domain effects', () => {
  assert.match(lifecycle, /isPublisher: \(socket\) => micRuntime\.isPublisher\(socket\)/);
  assert.match(lifecycle, /noteDisconnected: \(\) => takeController\.noteQualityEvent\('mic-transport-disconnected'\)/);
  assert.match(lifecycle, /socket\.participantId\s*&& participants\.micOwnerId === socket\.participantId/);
  assert.match(lifecycle, /detachPublisher: \(socket\) => micRuntime\.detachPublisher\(socket\)/);
  assert.match(lifecycle, /clearMediaAuthority: \(\) => clearMicMediaAuthority\(\)/);
  assert.match(lifecycle, /const directMediaStillLive = micRuntime\.directMediaConnected\(\)/);
  assert.match(lifecycle, /session\.setMicExpected\(directMediaStillLive\)/);
  assert.match(lifecycle, /micTransportGrace\.schedule\(ownerId\)/);
  assert.match(lifecycle, /maybeStopLiveSourceWhenUnarmed: \(\) => maybeStopLiveSourceWhenUnarmed\(\)/);
  assert.match(lifecycle, /calibration\.collecting/);
  assert.match(lifecycle, /calibration\.fail\('Microphone disconnected during calibration\.'\)/);
  assert.match(lifecycle, /commands\.cancelActiveContentValidation\(\)/);
  assert.match(lifecycle, /effects\.reportTimingStatus\(\)/);
  assert.match(lifecycle, /reportStatus: \(\) => effects\.reportStatus\(\)/);

  assert.match(server, /mic: micRuntime/);
  assert.match(server, /participants,/);
  assert.match(server, /reportTimingStatus: \(\) => broadcastJson\(timingCalibrationStatusPayload\(\)\)/);

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
  assert.match(close, /relayRobotMapping\.disconnectSource\(socket\)/);
  assert.match(close, /relayMicLifecycle\.disconnect\(socket\)/);
  assert.match(close, /backingDisconnectCoordinator\.handle\(socket\)/);
  assert.match(close, /participants\.detach\(socket\.participantConnectionId, Date\.now\(\)\)/);
});
