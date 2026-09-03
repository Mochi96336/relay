import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  functionCode,
  parseTypeScriptSource,
  sourceCode,
  variableInitializerCode,
} from './support/source-contract.js';

const app = parseTypeScriptSource(
  new URL('../public/app.js', import.meta.url),
  readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'),
);
const server = parseTypeScriptSource(
  new URL('../src/server.ts', import.meta.url),
  readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'),
);
const liveStatus = parseTypeScriptSource(
  new URL('../public/live-status.js', import.meta.url),
  readFileSync(new URL('../public/live-status.js', import.meta.url), 'utf8'),
);
const presence = parseTypeScriptSource(
  new URL('../public/mic-presence.js', import.meta.url),
  readFileSync(new URL('../public/mic-presence.js', import.meta.url), 'utf8'),
);
const stateCss = readFileSync(new URL('../public/live-state.css', import.meta.url), 'utf8');

const appCode = sourceCode(app);
const liveStatusCode = sourceCode(liveStatus);
const presenceCode = sourceCode(presence);

test('local capture telemetry remains available without owning the visible waveform', () => {
  assert.match(appCode, /event\.data\.f0Hz/);
  assert.match(appCode, /pitchConfidence/);
  assert.match(appCode, /dispatchRelayEvent\('relay-local-mic-level'/);
  assert.doesNotMatch(presenceCode, /relay-local-mic-level/);
  assert.doesNotMatch(presenceCode, /local:/);
});

test('Room Mic telemetry is accepted only from current authenticated Mic owner and generation', () => {
  const commands = variableInitializerCode(server, 'commandProtocol');
  const handlerStart = commands.indexOf('micPresenceTelemetry: (socket, payload) => {');
  const parsePresence = commands.indexOf('const presence = parseMicPresenceTelemetry(payload);', handlerStart);
  const ownerFence = commands.indexOf('socket.participantId !== participants.micOwnerId', parsePresence);
  const mediaOwnerFence = commands.indexOf('socket.participantId !== micRuntime.mediaOwnerId', ownerFence);
  const generationFence = commands.indexOf('presence.captureGeneration !== micRuntime.mediaGeneration', mediaOwnerFence);
  const streamingFence = commands.indexOf('!micStreaming(nowMs)', generationFence);
  const rateLimit = commands.indexOf('nowMs - socket.micPresenceTelemetryAt! < 60', streamingFence);
  const broadcast = commands.indexOf("type: 'room-mic-presence'", rateLimit);

  assert.ok(handlerStart >= 0, 'Mic presence command handler must stay inside commandProtocol');
  assert.ok(parsePresence > handlerStart, 'telemetry must be parsed before authority checks consume it');
  assert.ok(ownerFence > parsePresence, 'participant Mic ownership must fence telemetry first');
  assert.ok(mediaOwnerFence > ownerFence, 'current media owner must agree with participant authority');
  assert.ok(generationFence > mediaOwnerFence, 'capture generation must agree with current media authority');
  assert.ok(streamingFence > generationFence, 'only currently streaming Mic evidence may be published');
  assert.ok(rateLimit > streamingFence, 'accepted evidence must remain rate-limited');
  assert.ok(broadcast > rateLimit, 'Room Mic presence may broadcast only after all acceptance fences');
});

test('singer publishes Room Mic evidence through the room status path', () => {
  assert.match(liveStatusCode, /MIC_PRESENCE_TELEMETRY_INTERVAL_MS = 80/);
  assert.match(liveStatusCode, /window\.addEventListener\('relay-local-mic-level'/);
  assert.match(liveStatusCode, /type: 'mic-presence-telemetry'/);
  assert.match(liveStatusCode, /captureGeneration/);
});

test('visible waveform has one semantic source category for remote and self owners', () => {
  assert.match(liveStatusCode, /message\.type === 'room-mic-presence'/);
  assert.match(liveStatusCode, /relay-room-mic-presence/);
  assert.match(presenceCode, /window\.addEventListener\('relay-room-mic-presence'/);
  assert.match(presenceCode, /room:\$\{ownerId\}:\$\{generation\}/);
  assert.doesNotMatch(presenceCode, /localActive|if \(localActive\) return/);
  assert.match(stateCss, /body\[data-room-mic="live"\] \.voice-input-evidence[\s\S]*?display: flex;/);
});

test('owner or generation change and stale Room Mic evidence clear the old visual tail', () => {
  const renderRoomMicState = functionCode(liveStatus, 'renderRoomMicState');
  assert.match(renderRoomMicState, /const ownerChanged = ownerId !== roomMicOwnerId/);
  assert.match(renderRoomMicState, /if \(!live \|\| ownerChanged\)/);

  const append = functionCode(presence, 'append');
  assert.match(append, /if \(source !== sourceKey\) reset\(source\)/);
  const staleTimer = functionCode(presence, 'armRoomStaleTimer');
  assert.match(staleTimer, /ROOM_EVIDENCE_STALE_MS/);

  const eventStart = presenceCode.indexOf("window.addEventListener('relay-room-mic-presence'");
  const eventEnd = presenceCode.indexOf('adoptRoomAuthority(window.relayProductAuthority ?? null);', eventStart);
  assert.ok(eventStart >= 0 && eventEnd > eventStart, 'Room Mic presence event handler must stay structurally identifiable');
  const eventBody = presenceCode.slice(eventStart, eventEnd);
  assert.match(eventBody, /if \(event\.detail\?\.active !== true\) \{[\s\S]*?reset\(\);[\s\S]*?return;/);
});

test('center-origin production renderer mirrors one history and never uses five bands as pitch', () => {
  const visualPoint = functionCode(presence, 'visualPoint');
  assert.match(visualPoint, /presenceSliceGeometry/);
  assert.match(visualPoint, /centerOriginX/);

  const envelopePath = functionCode(presence, 'envelopePath');
  assert.match(envelopePath, /const left = history\.map\(\(slice, index\) => visualPoint\(slice, index, 'left'\)\)/);
  assert.match(envelopePath, /const right = history[\s\S]*?\.slice\(0, -1\)[\s\S]*?visualPoint\(slice, index, 'right'\)[\s\S]*?\.reverse\(\)/);
  assert.match(envelopePath, /const samples = \[\.\.\.left, \.\.\.right\]/);
  assert.doesNotMatch(presenceCode, /centroid/);
});
