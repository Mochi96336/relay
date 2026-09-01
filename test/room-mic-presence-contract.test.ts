import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const liveStatus = readFileSync(new URL('../public/live-status.js', import.meta.url), 'utf8');
const presence = readFileSync(new URL('../public/mic-presence.js', import.meta.url), 'utf8');
const stateCss = readFileSync(new URL('../public/live-state.css', import.meta.url), 'utf8');

test('local capture telemetry remains available without owning the visible waveform', () => {
  assert.match(app, /event\.data\.f0Hz/);
  assert.match(app, /pitchConfidence/);
  assert.match(app, /dispatchRelayEvent\('relay-local-mic-level'/);
  assert.doesNotMatch(presence, /relay-local-mic-level/);
  assert.doesNotMatch(presence, /local:/);
});

test('Room Mic telemetry is accepted only from current authenticated Mic owner and generation', () => {
  const handlerStart = server.indexOf('micPresenceTelemetry: (socket, payload) => {');
  const parsePresence = server.indexOf('const presence = parseMicPresenceTelemetry(payload);', handlerStart);
  const ownerFence = server.indexOf('socket.participantId !== participants.micOwnerId', parsePresence);
  const mediaOwnerFence = server.indexOf('socket.participantId !== micRuntime.mediaOwnerId', ownerFence);
  const generationFence = server.indexOf('presence.captureGeneration !== micRuntime.mediaGeneration', mediaOwnerFence);
  const streamingFence = server.indexOf('!micStreaming(nowMs)', generationFence);
  const rateLimit = server.indexOf('nowMs - socket.micPresenceTelemetryAt! < 60', streamingFence);
  const broadcast = server.indexOf("type: 'room-mic-presence'", rateLimit);

  assert.ok(handlerStart >= 0);
  assert.ok(parsePresence > handlerStart);
  assert.ok(ownerFence > parsePresence);
  assert.ok(mediaOwnerFence > ownerFence);
  assert.ok(generationFence > mediaOwnerFence);
  assert.ok(streamingFence > generationFence);
  assert.ok(rateLimit > streamingFence);
  assert.ok(broadcast > rateLimit);
});

test('singer publishes Room Mic evidence through the room status path', () => {
  assert.match(liveStatus, /MIC_PRESENCE_TELEMETRY_INTERVAL_MS = 80/);
  assert.match(liveStatus, /window\.addEventListener\('relay-local-mic-level'/);
  assert.match(liveStatus, /type: 'mic-presence-telemetry'/);
  assert.match(liveStatus, /captureGeneration/);
});

test('visible waveform has one semantic source category for remote and self owners', () => {
  assert.match(liveStatus, /message\.type === 'room-mic-presence'/);
  assert.match(liveStatus, /relay-room-mic-presence/);
  assert.match(presence, /window\.addEventListener\('relay-room-mic-presence'/);
  assert.match(presence, /room:\$\{ownerId\}:\$\{generation\}/);
  assert.doesNotMatch(presence, /localActive|if \(localActive\) return/);
  assert.match(stateCss, /body\[data-room-mic="live"\] \.voice-input-evidence[\s\S]*?display: flex;/);
});

test('owner or generation change and stale Room Mic evidence clear the old visual tail', () => {
  assert.match(liveStatus, /const ownerChanged = ownerId !== roomMicOwnerId/);
  assert.match(liveStatus, /if \(!live \|\| ownerChanged\)/);
  assert.match(presence, /if \(source !== sourceKey\) reset\(source\)/);
  assert.match(presence, /ROOM_EVIDENCE_STALE_MS = 320/);
  assert.match(presence, /armRoomStaleTimer/);
  const eventStart = presence.indexOf("window.addEventListener('relay-room-mic-presence'");
  assert.ok(eventStart >= 0);
  const eventBody = presence.slice(eventStart);
  assert.match(eventBody, /if \(event\.detail\?\.active !== true\) \{[\s\S]*?reset\(\);[\s\S]*?return;/);
});

test('center-origin production renderer mirrors one history and never uses five bands as pitch', () => {
  assert.match(presence, /centerOriginX/);
  assert.match(presence, /const left = history\.map\(\(slice, index\) => visualPoint\(slice, index, 'left'\)\)/);
  assert.match(presence, /const right = history[\s\S]*?\.slice\(0, -1\)[\s\S]*?visualPoint\(slice, index, 'right'\)[\s\S]*?\.reverse\(\)/);
  assert.match(presence, /const samples = \[\.\.\.left, \.\.\.right\]/);
  assert.match(presence, /presenceSliceGeometry/);
  assert.doesNotMatch(presence, /centroid/);
});
