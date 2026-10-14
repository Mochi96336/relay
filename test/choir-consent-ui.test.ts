import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const file = async (path: string) =>
  readFile(new URL(path, import.meta.url), 'utf8');

test('invite-only second Mic controls stay hidden and inaccessible in ordinary N=1 page', async () => {
  const html = await file('../public/index.html');
  const presence = await file('../public/presence.js');
  const app = await file('../public/choir-consent-ui.js');
  const server = await file('../src/server.ts');
  assert.match(html, /id="choir-invite-open"[^>]*hidden/);
  assert.match(html, /id="choir-consent-panel"[^>]*hidden/);
  for (const id of [
    'choir-secondary-person', 'choir-invite-send', 'choir-accept',
    'choir-decline', 'choir-withdraw', 'choir-consent-close',
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /src="\/choir-consent-ui\.js"/);
  assert.match(app, /trigger\.hidden = !hostAllowed \|\| choices\.length === 0/);
  assert.match(app, /panel\.hidden = !show/);
  assert.match(presence, /choirConsentAvailable = false/);
  assert.match(presence, /sessionAuthorityFresh/);
  assert.match(presence, /relay-choir-consent-command/);
  assert.match(server, /if \(choirConsent\) sendJson\(socket, \{\s*type: 'choir-consent-available'/);
  assert.match(server, /\(\) => false,[\s\S]*?\(\) => true,[\s\S]*?choirShadowConfig/);
  assert.doesNotMatch(app, /getUserMedia|sendAudioPacket|bindVerifiedSecondary/);
});

test('invitation text is generated as textContent, never injecting a nickname as HTML', async () => {
  const app = await file('../public/choir-consent-ui.js');
  assert.match(app, /option\.textContent = singer\.nickname/);
  assert.match(app, /invitationCopy\.textContent = t\('choir\.invitationFrom'/);
  assert.match(app, /window\.addEventListener\('relay-choir-consent-availability'/);
  assert.match(app, /if \(!authorityFresh\) resetConnection\(\)/);
  assert.match(app, /acceptedAsGuest = message\.secondaryId === myId\(\)/);
  const i18n = await file('../public/i18n.js');
  assert.equal(i18n.match(/'choir\.previewOnly':/g)?.length, 2);
  assert.equal(i18n.match(/'choir\.withdraw':/g)?.length, 2);
  assert.equal(i18n.match(/'choir\.invitationFrom':/g)?.length, 2);
});
