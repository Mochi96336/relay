import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const liveStatus = readFileSync(new URL('../public/live-status.js', import.meta.url), 'utf8');
const presence = readFileSync(new URL('../public/mic-presence.js', import.meta.url), 'utf8');
const stateCss = readFileSync(new URL('../public/live-state.css', import.meta.url), 'utf8');

test('Room Mic Presence is accepted only from the current authenticated Mic owner', () => {
  assert.match(server, /parseMicPresenceTelemetry/);
  const start = server.indexOf("if (payload.type === 'mic-presence-telemetry')");
  const end = server.indexOf("if (payload.type === 'product-status-request')", start);
  assert.ok(start >= 0 && end > start);
  const handler = server.slice(start, end);

  assert.match(handler, /socket\.participantId !== participants\.micOwnerId/);
  assert.match(handler, /socket\.participantId !== micMediaOwnerId/);
  assert.match(handler, /micMediaGeneration === null/);
  assert.match(handler, /!micStreaming\(nowMs\)/);
  assert.match(handler, /nowMs - socket\.micPresenceTelemetryAt! < 60/);
});

test('server owns visible singer identity and capture generation', () => {
  const start = server.indexOf("if (payload.type === 'mic-presence-telemetry')");
  const end = server.indexOf("if (payload.type === 'product-status-request')", start);
  const handler = server.slice(start, end);

  assert.match(handler, /type: 'room-mic-presence'/);
  assert.match(handler, /ownerId: micMediaOwnerId/);
  assert.match(handler, /captureGeneration: micMediaGeneration/);
  assert.doesNotMatch(handler, /payload\.captureGeneration/);
});

test('singer sends lightweight local FFT telemetry on the always-on room status socket', () => {
  assert.match(liveStatus, /MIC_PRESENCE_TELEMETRY_INTERVAL_MS = 80/);
  assert.match(liveStatus, /window\.addEventListener\('relay-local-mic-level'/);
  assert.match(liveStatus, /type: 'mic-presence-telemetry'/);
  assert.match(liveStatus, /spectrumBands/);
  assert.match(liveStatus, /isSelfOwner\(latestProductStatus\)/);
});

test('listeners receive the canonical current singer and reuse the same ribbon renderer', () => {
  assert.match(liveStatus, /message\.type === 'room-mic-presence'/);
  assert.match(liveStatus, /relay-room-mic-presence/);
  assert.match(liveStatus, /document\.body\.dataset\.roomMic = 'live'/);
  assert.match(presence, /window\.addEventListener\('relay-room-mic-presence'/);
  assert.match(presence, /if \(localActive\) return;/);
  assert.match(presence, /room:\$\{ownerId\}:\$\{generation >>> 0\}/);
  assert.match(stateCss, /body\[data-room-mic="live"\] \.voice-input-evidence[\s\S]*?display: flex;/);
});

test('Mic handoff or stopped room Mic clears the old visual tail', () => {
  assert.match(liveStatus, /const ownerChanged = ownerId !== roomMicOwnerId/);
  assert.match(liveStatus, /if \(!live \|\| ownerChanged\)/);
  assert.match(liveStatus, /active: false/);
  assert.match(presence, /sourceKey\.startsWith\('room:'\)/);
  assert.match(presence, /if \(source !== sourceKey\) reset\(source\)/);
});
