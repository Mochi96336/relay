import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  functionCode,
  parseTypeScriptSource,
  sourceCode,
  variableInitializerCode,
} from './support/source-contract.js';

const server = parseTypeScriptSource(
  new URL('../src/server.ts', import.meta.url),
  readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'),
);
const queryProtocol = parseTypeScriptSource(
  new URL('../src/relay-query-protocol.ts', import.meta.url),
  readFileSync(new URL('../src/relay-query-protocol.ts', import.meta.url), 'utf8'),
);

const MOVED_QUERY_TYPES = [
  'clock-ping',
  'session-status-request',
  'product-status-request',
  'take-status-request',
  'room-song-status-request',
  'room-song-command-status-request',
  'youtube-timeline-request',
  'source-status-request',
  'timing-calibration-status-request',
] as const;

test('server delegates read-only text protocol selection through the query protocol seam', () => {
  const serverCode = sourceCode(server);
  const serverFlow = functionCode(server, 'startRelayServer');
  const wiring = variableInitializerCode(server, 'queryProtocol');
  const factory = functionCode(queryProtocol, 'createRelayQueryProtocol');

  assert.match(wiring, /^createRelayQueryProtocol<RelaySocket>\(\{/);
  assert.match(serverFlow, /if \(queryProtocol\.dispatch\(socket, payload\)\) return;/);
  for (const type of MOVED_QUERY_TYPES) {
    assert.doesNotMatch(
      serverCode,
      new RegExp(`payload\\.type === ['"]${type}['"]`),
      `${type} should be selected by relay-query-protocol instead of the socket callback`,
    );
    assert.match(factory, new RegExp(`['"]${type}['"]`));
  }
});

test('query protocol still does not own mutating command authority', () => {
  const serverFlow = functionCode(server, 'startRelayServer');
  const factory = functionCode(queryProtocol, 'createRelayQueryProtocol');

  assert.match(serverFlow, /registrationProtocol\.dispatch\(socket, payload\)/);
  assert.doesNotMatch(factory, /start-take|stop-take|room-song-command'\s*,\s*\(socket, payload\)|register'\s*,/);
});
