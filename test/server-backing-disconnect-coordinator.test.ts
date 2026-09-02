import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const coordinator = readFileSync(
  new URL('../src/relay-backing-disconnect-coordinator.ts', import.meta.url),
  'utf8',
);

test('server delegates only Backing disconnect ordering through the coordinator seam', () => {
  assert.match(server, /createRelayBackingDisconnectCoordinator<RelaySocket>/);
  assert.match(server, /backingDisconnectCoordinator\.handle\(socket\)/);
  assert.doesNotMatch(
    server,
    /if \(backingRuntime\.isSocket\(socket\)\) \{\s*takeController\.noteQualityEvent\('backing-transport-disconnected'\)/,
  );
});

test('server composition retains Backing disconnect authority and domain effects', () => {
  assert.match(server, /isBacking: \(socket\) => backingRuntime\.isSocket\(socket\)/);
  assert.match(server, /noteDisconnected: \(\) => takeController\.noteQualityEvent\('backing-transport-disconnected'\)/);
  assert.match(server, /clearRobotBackingBoundaryRequest: \(\) => clearRobotBackingBoundaryRequest\(\)/);
  assert.match(server, /detach: \(socket\) => backingRuntime\.detach\(socket\)/);
  assert.match(server, /clearBackingExpectation: \(\) => session\.setBackingExpected\(false\)/);
  assert.match(server, /calibration\.collecting/);
  assert.match(server, /calibration\.fail\('Desktop Source disconnected during calibration\.'\)/);
  assert.match(server, /cancelActiveContentValidation\(\)/);
  assert.match(server, /broadcastJson\(timingCalibrationStatusPayload\(\)\)/);
  assert.match(server, /reportSourceStatus: \(\) => broadcastJson\(sourceStatusPayload\(\)\)/);
  assert.match(server, /reportStatus: \(\) => broadcastStatus\(\)/);

  assert.doesNotMatch(coordinator, /^import /m);
  assert.doesNotMatch(
    coordinator,
    /backingRuntime|session\.setBackingExpected|calibration\.(?:collecting|fail)|cancelActiveContentValidation|broadcastJson|broadcastStatus/,
  );
});

test('socket close retains replacement fence plus Robot, Mic, Backing dispatch and participant composition', () => {
  const closeStart = server.indexOf("socket.on('close', () => {");
  assert.ok(closeStart >= 0);
  const closeEnd = server.indexOf("\n  });\n});\n\nwss.on('close'", closeStart);
  assert.ok(closeEnd > closeStart);
  const close = server.slice(closeStart, closeEnd);

  const fence = close.indexOf('if (!socket.replaced) {');
  const robot = close.indexOf('robotDisconnectCoordinator.handle(socket);');
  const mic = close.indexOf('micDisconnectCoordinator.handle(socket);');
  const backing = close.indexOf('backingDisconnectCoordinator.handle(socket);');

  assert.ok(fence >= 0 && robot > fence);
  assert.ok(mic > robot);
  assert.ok(backing > mic);
  assert.match(close, /participants\.detach\(socket\.participantConnectionId, Date\.now\(\)\)/);
});
