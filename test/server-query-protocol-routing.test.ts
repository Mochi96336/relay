import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const queryProtocol = readFileSync(new URL('../src/relay-query-protocol.ts', import.meta.url), 'utf8');

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
  assert.match(server, /createRelayQueryProtocol<RelaySocket>\(\{/);
  assert.match(server, /if \(queryProtocol\.dispatch\(socket, payload\)\) return;/);
  for (const type of MOVED_QUERY_TYPES) {
    assert.doesNotMatch(
      server,
      new RegExp(`payload\.type === ['"]${type}['"]`),
      `${type} should be selected by relay-query-protocol instead of the socket callback`,
    );
    assert.match(queryProtocol, new RegExp(`['"]${type}['"]`));
  }
});

test('query protocol still does not own mutating command authority', () => {
  assert.match(server, /registrationProtocol\.dispatch\(socket, payload\)/);
  assert.doesNotMatch(queryProtocol, /start-take|stop-take|room-song-command'\s*,\s*\(socket, payload\)|register'\s*,/);
});