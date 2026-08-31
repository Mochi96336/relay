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
  assert.match(server, /const takeDir = path\.resolve\(relayConfig\.takeDir\);/);
  assert.match(server, /key: relayConfig\.infrastructureKey,/);
  assert.match(server, /legacyAuthorized: relayConfig\.legacyTestInfrastructure,/);
  assert.doesNotMatch(server, /process\.env|function envMs|function envPositiveInt/);
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
