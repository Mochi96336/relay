import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const file = async (path: string) =>
  readFile(new URL(path, import.meta.url), 'utf8');

test('second Mic controls live in the Mic row, hidden in an ordinary N=1 page', async () => {
  const html = await file('../public/index.html');
  const presence = await file('../public/presence.js');
  const app = await file('../public/choir-ui.js');
  const server = await file('../src/server.ts');
  const runtime = await file('../src/choir-runtime.ts');
  assert.match(html, /<div class="mic-actions">[\s\S]*?id="choir-invite-open"[^>]*hidden[\s\S]*?id="choir-withdraw"[^>]*hidden[\s\S]*?<\/div>/);
  assert.doesNotMatch(html, /choir-consent-status/);
  assert.doesNotMatch(html, /choir-consent-panel|choir-dismiss|choir-accept|choir-secondary-person/,
    'no extra card, no owner kick, no invitation controls');
  assert.match(html, /src="\/choir-ui\.js"/);
  // Only someone who does not hold the Mic can join, and only while someone does.
  assert.match(app, /joinButton\.hidden = !canJoin\(\)/);
  assert.match(app, /session\.micOwnerId !== myId\(\)/);
  // Like the Mic, the second Mic can be taken over.
  // The label's data-i18n key changes with it, so a re-translation keeps it.
  assert.match(app, /joinButton\.dataset\.i18n = takeOver \? 'choir\.takeOver' : 'choir\.invite'/);
  assert.match(presence, /choirAvailable = false/);
  assert.match(presence, /relay-choir-command/);
  // Offered only with Choir on, and only to an authenticated page.
  assert.match(server, /const choir = relayConfig\.choir \? new ChoirRuntime\(/);
  assert.match(server, /choir\?\.welcome\(socket\)/);
  assert.match(runtime, /welcome\(socket: RelaySocket\) \{\s*this\.deps\.send\(socket, \{ type: 'choir-available' \}\)/);
  assert.doesNotMatch(runtime, /choir-secondary-dismiss|choir-secondary-invite/);
  assert.doesNotMatch(app, /getUserMedia|sendAudioPacket|bindVerifiedSecondary|innerHTML/);
});

test('a joined B sets its own Mic gain, as the Mic owner does', async () => {
  const html = await file('../public/index.html');
  const app = await file('../public/choir-ui.js');
  const presence = await file('../public/presence.js');
  const runtime = await file('../src/choir-runtime.ts');
  const css = await file('../public/live-ia.css');
  const mix = await file('../public/mix-controls.js');
  assert.doesNotMatch(html, /choir-gain/);
  assert.equal((html.match(/id="mic-gain"/g) ?? []).length, 1);
  assert.match(css, /body\[data-choir-guest="joined"\] \.mic-live-control \{\s*display: block;/);
  assert.match(mix, /storedNumber\(MIC_GAIN_KEY, 0, 40\)/);
  assert.match(mix, /type: 'choir-secondary-gain', micGainDb: micGainDb\(\)/);
  assert.match(presence, /choirCommandMessage\(event\.detail\)/);
  assert.match(runtime, /case 'choir-secondary-gain'[\s\S]*?session\.setSecondaryMicGainDb\(gainDb\)/);
});

test('the second Mic copy exists in both locales and the old invitation copy is gone', async () => {
  const i18n = await file('../public/i18n.js');
  for (const key of ['choir.invite', 'choir.takeOver', 'choir.withdraw', 'choir.replaced']) {
    assert.equal(i18n.match(new RegExp(`'${key.replace('.', '\\.')}':`, 'g'))?.length, 2, key);
  }
  assert.doesNotMatch(i18n, /'choir\.(previewOnly|invitationFrom|panelTitle|beginRoom|connectMedia|dismiss)':/);
});

test('B starts its Mic only on its own tap and connects when the server asks for its media', async () => {
  const html = await file('../public/index.html');
  const app = await file('../public/choir-ui.js');
  const media = await file('../public/choir-media-client.js');
  const presence = await file('../public/presence.js');
  assert.match(html, /src="\/choir-media-client\.js"/);
  // The media client loads with the controls, so the tap cannot be lost.
  assert.match(app, /^import '\.\/choir-media-client\.js';/m);
  // The join tap itself starts capture: browsers require a gesture for the Mic.
  assert.match(app, /relay-choir-start-secondary-capture[\s\S]*?publishCommand\('choir-secondary-join'\)/);
  assert.match(presence, /import \{ choirCommandMessage, ChoirSeatCommands \} from '\.\/choir-commands\.js'/);
  assert.match(media, /type === 'choir-media-ready'[\s\S]*?requestClaim\(\)/);
  assert.doesNotMatch(media, /roomEpoch|choir-room-ready/);
  assert.match(media, /wsUrl\(\{ compress: false \}\)/);
  assert.match(media, /sendParticipantAuthentication\(socket\)/);
  assert.match(media, /message\.participantId !== window\.relayParticipantId/);
  assert.match(media, /'choir-secondary-media-register'/);
  assert.match(media, /packetVersion: capture\.packetVersion, sampleRate: sourceRate/);
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

test('second Mic reports capture failure and takeover, then clears the notice on retry', async () => {
  const { runInNewContext } = await import('node:vm');
  const listeners = new Map<string, (event: { detail?: any }) => void>();
  let join = () => {};
  const button = { dataset: {} as Record<string, string>, addEventListener: (_: string, cb: () => void) => { join = cb; } };
  const notice = { hidden: true, textContent: '' };
  const window = { relayParticipantId: 'b', addEventListener: (type: string, fn: (e: any) => void) => listeners.set(type, fn),
    dispatchEvent() {}, relayI18n: { t: (key: string) => key } };
  const document = { body: { dataset: {} }, querySelector: (sel: string) => sel === '#choir-capture-notice'
    ? notice : sel === '#choir-invite-open' ? button : { addEventListener() {} } };
  const source = (await file('../public/choir-ui.js')).replace(/^import .*;$/gm, '');
  runInNewContext(source, { document, window, Event, CustomEvent: class { constructor(..._args: any[]) {} },
    clearTimeout() {}, setTimeout() { return 1; } });
  const emit = (type: string, detail: object) => listeners.get(type)!({ detail });
  emit('relay-choir-availability', { available: true });
  emit('relay-presence-state', { authorityFresh: true,
    session: { micOwnerId: 'a', micConnected: true, serverIncarnation: 'server' } });
  join();
  emit('relay-choir-media-connection', { state: 'capture-failed', reason: 'permission-denied' });
  emit('relay-choir-message', { type: 'choir-secondary-consent-status', status: 'withdrawn', secondaryId: 'b' });
  assert.equal(notice.hidden, false);
  assert.equal(notice.textContent, 'voice.permissionRequired');
  join();
  assert.equal(notice.hidden, true);
  emit('relay-choir-message', { type: 'choir-secondary-consent-status', status: 'accepted', secondaryId: 'b' });
  emit('relay-product-status', { room: { duet: { secondaryId: 'b' } } });
  emit('relay-choir-message', { type: 'choir-secondary-consent-status', status: 'revoked', secondaryId: 'b', reason: 'replaced' });
  assert.equal(notice.textContent, 'choir.replaced');
  assert.equal(button.dataset.i18n, 'choir.takeOver');
  join();
  assert.equal(notice.hidden, true);
});
