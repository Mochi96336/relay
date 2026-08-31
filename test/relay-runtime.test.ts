import assert from 'node:assert/strict';
import test from 'node:test';

import { loadRelayConfig } from '../src/config.js';
import { readRepositoryTextFile } from './helpers/source-contract.js';

test('server entry parses deployment config once and delegates activation', () => {
  const entry = readRepositoryTextFile('src/server-entry.ts');

  assert.match(entry, /startRelayRuntime\(loadRelayConfig\(\)\)/);
  assert.doesNotMatch(entry, /process\.env|server\.js/);
});

test('runtime constructs the server explicitly without an environment or dynamic-import bridge', () => {
  const runtime = readRepositoryTextFile('src/relay-runtime.ts');
  const server = readRepositoryTextFile('src/server.ts');

  assert.match(runtime, /import \{ startRelayServer \} from '\.\/server\.js';/);
  assert.match(runtime, /const relayServer = await startRelayServer\(config\);/);
  assert.doesNotMatch(runtime, /process\.env|applyLegacyServerEnvironment|import\('\.\/server\.js'\)/);
  assert.match(server, /export async function startRelayServer\(relayConfig: RelayConfig\)/);
  assert.match(server, /const port = relayConfig\.port;/);
  assert.match(server, /const relayKey = relayConfig\.relayKey;/);
  assert.doesNotMatch(
    server,
    /process\.env\.(?:PORT|RELAY_KEY|RELAY_LIVE_PREBUFFER_MS|RELAY_MIC_RETENTION_MS|RELAY_CALIBRATION_TIMEOUT_MS|RELAY_HEARTBEAT_MS|RELAY_PARTICIPANT_GRACE_MS|RELAY_MIC_TRANSPORT_GRACE_MS|RELAY_AUTO_CALIBRATE|RELAY_AUTO_CALIBRATION_RETRY_MS|RELAY_CALIBRATION_VALIDATION|RELAY_CALIBRATION_PROBE|RELAY_BACKING_GRACE_MS|RELAY_CALIBRATION_AGREEMENT|RELAY_CALIBRATION_TOLERANCE_MS|RELAY_CALIBRATION_PROVISIONAL_CONFIDENCE|RELAY_CALIBRATION_MAX_LAG_MS)/,
  );
});

test('runtime owns process signals while the constructed server owns the shutdown transaction', () => {
  const runtime = readRepositoryTextFile('src/relay-runtime.ts');
  const server = readRepositoryTextFile('src/server.ts');

  assert.match(runtime, /for \(const signal of \['SIGTERM', 'SIGINT'\] as const\)/);
  assert.match(runtime, /process\.on\(signal/);
  assert.match(runtime, /relayServer\.gracefulShutdown\(signal\)/);
  assert.match(server, /async function gracefulShutdown\(signal: NodeJS\.Signals\)/);
  assert.match(server, /return \{ gracefulShutdown \} as const;/);
  assert.doesNotMatch(server, /process\.on\(signal/);
});
