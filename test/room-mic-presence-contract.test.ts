import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const liveStatus = readFileSync(new URL('../public/live-status.js', import.meta.url), 'utf8');
const presence = readFileSync(new URL('../public/mic-presence.js', import.meta.url), 'utf8');
const stateCss = readFileSync(new URL('../public/live-state.css', import.meta.url), 'utf8');

test('F0 stays a capture-worklet side channel and local singer rendering skips server roundtrip', () => {
  assert.match(app, /event\.data\.f0Hz/);
  assert.match(app, /pitchConfidence/);
  assert.match(app, /captureGeneration: captureGeneration >>> 0/);
  assert.match(app, /dispatchRelayEvent\('relay-local-mic-level'/);
  assert.match(presence, /window\.addEventListener\('relay-local-mic-level'/);
  assert.match(presence, /local:\$\{generation\}/);
});

test('Room Mic telemetry is accepted only from current authenticated Mic owner and generation', () => {
  assert.match(server, /parseMicPresenceTelemetry/);
  const start = server.indexOf("if (payload.type === 'mic-presence-telemetry')");
  const end = server.indexOf("if (payload.type === 'product-status-request')", start);
  assert.ok(start >= 0 && end > start);
  const handler = server.slice(start, end);

  assert.match(handler, /socket\.participantId !== participants\.micOwnerId/);
  assert.match(handler, /socket\.participantId !== micMediaOwnerId/);
  assert.match(handler, /micMediaGeneration === null/);
  assert.match(handler, /presence\.captureGeneration !== micMediaGeneration/);
  assert.match(handler, /!micStreaming\(nowMs\)/);
  assert.match(handler, /nowMs - socket\.micPresenceTelemetryAt! < 60/);
  assert.match(handler, /f0Hz: presence\.f0Hz/);
  assert.match(handler, /pitchConfidence: presence\.pitchConfidence/);
});

test('singer sends lightweight F0 telemetry on the existing room status socket', () => {
  assert.match(liveStatus, /MIC_PRESENCE_TELEMETRY_INTERVAL_MS = 80/);
  assert.match(liveStatus, /window\.addEventListener\('relay-local-mic-level'/);
  assert.match(liveStatus, /type: 'mic-presence-telemetry'/);
  assert.match(liveStatus, /captureGeneration/);
  assert.match(liveStatus, /f0Hz/);
  assert.match(liveStatus, /pitchConfidence/);
  assert.match(liveStatus, /isSelfOwner\(latestProductStatus\)/);
});

test('listeners receive canonical singer generation plus truthful F0 and reuse the same renderer', () => {
  assert.match(liveStatus, /message\.type === 'room-mic-presence'/);
  assert.match(liveStatus, /relay-room-mic-presence/);
  assert.match(liveStatus, /f0Hz/);
  assert.match(liveStatus, /pitchConfidence/);
  assert.match(presence, /window\.addEventListener\('relay-room-mic-presence'/);
  assert.match(presence, /if \(localActive\) return;/);
  assert.match(presence, /room:\$\{ownerId\}:\$\{generation\}/);
  assert.match(stateCss, /body\[data-room-mic="live"\] \.voice-input-evidence[\s\S]*?display: flex;/);
});

test('handoff, capture generation change and stale remote evidence clear the old visual tail', () => {
  assert.match(liveStatus, /const ownerChanged = ownerId !== roomMicOwnerId/);
  assert.match(liveStatus, /if \(!live \|\| ownerChanged\)/);
  assert.match(presence, /if \(source !== sourceKey\) reset\(source\)/);
  assert.match(presence, /REMOTE_EVIDENCE_STALE_MS = 320/);
  assert.match(presence, /armRemoteStaleTimer/);
  assert.match(presence, /sourceKey\.startsWith\('local:'\)/);
});

test('center-origin production renderer mirrors one history and never uses five bands as pitch', () => {
  assert.match(presence, /centerOriginX/);
  assert.match(presence, /const left = history\.map\(\(slice, index\) => visualPoint\(slice, index, 'left'\)\)/);
  assert.match(presence, /const right = history[\s\S]*?\.slice\(0, -1\)[\s\S]*?visualPoint\(slice, index, 'right'\)[\s\S]*?\.reverse\(\)/);
  assert.match(presence, /const samples = \[\.\.\.left, \.\.\.right\]/);
  assert.match(presence, /presenceSliceGeometry/);
  assert.doesNotMatch(presence, /centroid/);
});
