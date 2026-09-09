import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  functionCode,
  importSources,
  parseTypeScriptSource,
  sourceCode,
  variableInitializerCode,
} from './support/source-contract.js';

const server = parseTypeScriptSource(
  new URL('../src/server.ts', import.meta.url),
  readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'),
);
const coordinator = parseTypeScriptSource(
  new URL('../src/relay-backing-grace-expiry-coordinator.ts', import.meta.url),
  readFileSync(new URL('../src/relay-backing-grace-expiry-coordinator.ts', import.meta.url), 'utf8'),
);

test('expireBackingGrace retains live room facts and delegates the consequence policy', () => {
  const expire = functionCode(server, 'expireBackingGrace');
  assert.match(expire, /micRuntime\.controlConnected\(\)/);
  assert.match(expire, /webTransportMicConnected\(\)/);
  assert.match(expire, /micTransportGrace\.pending/);
  assert.match(
    expire,
    /backingGraceExpiryCoordinator\.expire\(\{\s*roomHasSong: roomHasSong\(\),\s*micArmed,\s*\}\)/,
  );

  assert.doesNotMatch(expire, /stopLiveSource\(\)/);
  assert.doesNotMatch(expire, /backingRuntime\.retireRobotRoute\(\)/);
  assert.doesNotMatch(expire, /clearRobotBackingBoundaryRequest\(\)/);
  assert.doesNotMatch(expire, /invalidateMicTiming\(/);
  assert.doesNotMatch(expire, /broadcastStatus\(\)/);
});

test('server composition supplies every Backing grace consequence without moving authority', () => {
  assert.ok(importSources(server).includes('./relay-backing-grace-expiry-coordinator.js'));
  const composition = variableInitializerCode(server, 'backingGraceExpiryCoordinator');
  assert.match(composition, /^createRelayBackingGraceExpiryCoordinator\(\{/);
  assert.match(composition, /stopLiveSource: \(\) => stopLiveSource\(\)/);
  assert.match(composition, /retireRobotRoute: \(\) => backingRuntime\.retireRobotRoute\(\)/);
  assert.match(
    composition,
    /clearRobotBackingBoundaryRequest: \(\) => clearRobotBackingBoundaryRequest\(\)/,
  );
  assert.match(composition, /invalidateMicTiming: \(message\) => invalidateMicTiming\(message\)/);
  assert.match(composition, /reportStatus: \(\) => broadcastStatus\(\)/);
});

test('Backing grace coordinator owns policy without importing runtime authorities', () => {
  const code = sourceCode(coordinator);
  assert.doesNotMatch(code, /^import /m);
  assert.doesNotMatch(
    code,
    /BackingRuntime|MicRuntime|AudioSession|TimingRuntime|CalibrationSession|broadcastStatus|roomHasSong|webTransportMicConnected|micTransportGrace/,
  );
});
