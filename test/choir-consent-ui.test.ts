import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const file = async (path: string) =>
  readFile(new URL(path, import.meta.url), 'utf8');

test('second Mic controls live in the Mic row, hidden in an ordinary N=1 page', async () => {
  const html = await file('../public/index.html');
  const presence = await file('../public/presence.js');
  const app = await file('../public/choir-consent-ui.js');
  const server = await file('../src/server.ts');
  assert.match(html, /<div class="mic-actions">[\s\S]*?id="choir-invite-open"[^>]*hidden[\s\S]*?id="choir-withdraw"[^>]*hidden[\s\S]*?<\/div>/);
  assert.match(html, /id="choir-consent-status"[^>]*hidden/);
  assert.doesNotMatch(html, /choir-consent-panel|choir-dismiss|choir-accept|choir-secondary-person/,
    'no extra card, no owner kick, no invitation controls');
  assert.match(html, /src="\/choir-consent-ui\.js"/);
  // Only someone who does not hold the Mic can join, and only while someone does.
  assert.match(app, /joinButton\.hidden = !canJoin\(\)/);
  assert.match(app, /session\.micOwnerId !== myId\(\)/);
  // Like the Mic, the second Mic can be taken over.
  assert.match(app, /t\(takeOver \? 'choir\.takeOver' : 'choir\.invite'\)/);
  assert.match(presence, /choirConsentAvailable = false/);
  assert.match(presence, /relay-choir-consent-command/);
  assert.match(server, /if \(choirConsent\) sendJson\(socket, \{\s*type: 'choir-consent-available'/);
  assert.match(server, /const choirMediaEnabled = relayConfig\.choirShadow && relayConfig\.choirMediaExperiment/);
  assert.doesNotMatch(server, /choir-secondary-dismiss/);
  assert.doesNotMatch(app, /getUserMedia|sendAudioPacket|bindVerifiedSecondary|innerHTML/);
});

test('the second Mic copy exists in both locales and the old invitation copy is gone', async () => {
  const i18n = await file('../public/i18n.js');
  for (const key of ['choir.invite', 'choir.takeOver', 'choir.withdraw', 'choir.joinRejected',
    'choir.micFailed', 'choir.revoked', 'choir.replaced']) {
    assert.equal(i18n.match(new RegExp(`'${key.replace('.', '\\.')}':`, 'g'))?.length, 2, key);
  }
  assert.doesNotMatch(i18n, /'choir\.(previewOnly|invitationFrom|panelTitle|beginRoom|connectMedia|dismiss)':/);
});

test('B starts its Mic only on its own tap and connects to each room the server announces', async () => {
  const html = await file('../public/index.html');
  const app = await file('../public/choir-consent-ui.js');
  const media = await file('../public/choir-secondary-media-client.js');
  const presence = await file('../public/presence.js');
  assert.match(html, /src="\/choir-secondary-media-client\.js"/);
  // The media client loads with the controls, so the tap cannot be lost.
  assert.match(app, /^import '\.\/choir-secondary-media-client\.js';/m);
  // The join tap itself starts capture: browsers require a gesture for the Mic.
  assert.match(app, /relay-choir-start-secondary-capture[\s\S]*?publishCommand\('choir-secondary-join'\)/);
  assert.match(presence, /payload\.type === 'choir-secondary-join'/);
  assert.match(media, /type === 'choir-room-ready'[\s\S]*?requestClaim\(\)/);
  assert.match(media, /wsUrl\(\{ compress: false \}\)/);
  assert.match(media, /sendParticipantAuthentication\(socket\)/);
  assert.match(media, /message\.participantId !== window\.relayParticipantId/);
  assert.match(media, /'choir-secondary-media-register'/);
  assert.match(media, /packetVersion: 2, sampleRate: sourceRate/);
  assert.match(media, /const sourceRate = await capture\.prepare\(\)/);
  assert.match(media, /capture\.attach\(socket, message\.sampleRate\)/);
  // YouTube-time alignment: B's local player position paired with its capture.
  assert.match(media, /'relay-choir-song-anchor'[\s\S]*?capture\.anchorFor\(/);
  const native = await file('../public/choir-secondary-capture.js');
  assert.match(native, /navigator\.mediaDevices\.getUserMedia/);
  assert.match(native, /createMicCaptureGraph/);
  assert.match(native, /firstSampleIndex = this\.cursor/);
  assert.match(native, /this\.cursor \+= samples/);
  assert.doesNotMatch(media, /navigator\.mediaDevices\.getUserMedia|new AudioWorkletNode|localStorage|sessionStorage|console\.log/);
});
