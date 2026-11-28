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
  assert.match(app, /capture-ready[\s\S]*?publishCommand\('choir-secondary-join', \{\s*expectedPrimaryId: joinScope.primaryId/);
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

async function choirPage() {
  const { runInNewContext } = await import('node:vm');
  const events: Array<{ type: string; detail?: any }> = [];
  const window = Object.assign(new EventTarget(), {
    relayParticipantId: 'b', relayI18n: { t: (key: string) => key },
  });
  const button = Object.assign(new EventTarget(), { dataset: {} as Record<string, string>, hidden: true });
  const leave = Object.assign(new EventTarget(), { dataset: {}, hidden: true });
  const notice = { hidden: true, textContent: '' };
  const document = { body: { dataset: {} }, querySelector: (sel: string) => sel === '#choir-capture-notice'
    ? notice : sel === '#choir-invite-open' ? button : leave };
  const source = (await file('../public/choir-ui.js')).replace(/^import .*;$/gm, '');
  let now = 0;
  let id = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  for (const type of ['relay-choir-command', 'relay-choir-stop-secondary-capture', 'relay-choir-pause-secondary-media'])
    window.addEventListener(type, event => events.push({ type, detail: (event as CustomEvent).detail }));
  runInNewContext(source, { document, window, Event, CustomEvent,
    setTimeout(run: () => void, ms: number) { timers.set(++id, { at: now + ms, run }); return id; },
    clearTimeout(key: number) { timers.delete(key); },
  });
  const emit = (type: string, detail: object) => window.dispatchEvent(new CustomEvent(type, { detail }));
  const presence = (authorityFresh: boolean) => emit('relay-presence-state', {
    authorityFresh, session: { micOwnerId: 'a', micConnected: true, serverIncarnation: 'server' },
  });
  const tap = () => button.dispatchEvent(new Event('click'));
  const ready = () => emit('relay-choir-media-connection', { state: 'capture-ready' });
  const join = () => { tap(); ready(); };
  const accept = () => emit('relay-choir-message', { type: 'choir-secondary-consent-status', status: 'accepted', secondaryId: 'b' });
  emit('relay-choir-availability', { available: true });
  presence(true);
  return { emit, presence, tap, ready, join, accept, notice, button, leave, events, advance(ms: number) {
    now += ms;
    for (const [key, timer] of timers) if (timer.at <= now) { timers.delete(key); timer.run(); }
  } };
}

test('second Mic reports capture failure and takeover, then clears the notice on retry', async () => {
  const { join, emit, notice, button } = await choirPage();
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

test('leaving during a control outage stops capture locally and never resumes', async () => {
  const f = await choirPage();
  f.join();
  f.accept();
  f.presence(false);
  assert.equal(f.leave.hidden, false);
  f.leave.dispatchEvent(new Event('click'));
  assert.equal(f.events.filter(e => e.type === 'relay-choir-stop-secondary-capture').length, 1);
  f.presence(true);
  assert.equal(f.leave.hidden, true);
  assert.equal(f.events.some(e => e.detail?.resume), false);
});

test('an unanswered recovery near the end of its grace cannot extend microphone capture', async () => {
  const f = await choirPage();
  f.join();
  f.accept();
  f.presence(false);
  assert.equal(f.notice.textContent, 'choir.reconnectingMic');
  f.advance(14_000);
  f.presence(true);
  assert.equal(f.events.some(e => e.detail?.resume), true);
  assert.equal(f.notice.textContent, 'choir.reconnectingMic');
  f.advance(1_000);
  assert.equal(f.notice.textContent, 'choir.recoveryTimedOut');
  assert.equal(f.leave.hidden, true, 'original 15 s grace expired while the resume reply was pending');
  assert.equal(f.events.filter(e => e.type === 'relay-choir-stop-secondary-capture').length, 1);
  f.accept();
  assert.equal(f.leave.hidden, true);
  assert.equal(f.events.at(-1)?.detail?.type, 'choir-secondary-withdraw');
});

test('successive control drops share a grace deadline until a resume is confirmed', async () => {
  const f = await choirPage();
  f.join();
  f.accept();
  f.presence(false);
  f.advance(7_000);
  f.presence(true);
  f.presence(false);
  f.advance(8_000);
  assert.equal(f.leave.hidden, true);
  f.presence(true);
  f.join();
  f.accept();
  f.presence(false);
  f.advance(14_000);
  f.presence(true);
  f.accept();
  f.advance(1_000);
  assert.equal(f.leave.hidden, false, 'confirmed resume cancels its grace timer');
  f.presence(false);
  f.advance(15_000);
  assert.equal(f.leave.hidden, true, 'the next outage gets its own deadline');
});

test("a resume refused because this singer's newer tab holds the seat explains the takeover", async () => {
  const f = await choirPage();
  f.join();
  f.accept();
  f.presence(false);
  f.presence(true);
  assert.equal(f.events.at(-1)?.detail?.resume, true);
  f.emit('relay-choir-message', { type: 'choir-consent-rejected', reason: 'replaced' });
  assert.equal(f.leave.hidden, true);
  assert.equal(f.notice.textContent, 'choir.replaced');
});

test('an unconfirmed join stops capture if the room changes before admission', async () => {
  const f = await choirPage();
  f.join();
  f.emit('relay-presence-state', {
    authorityFresh: true, session: { micOwnerId: 'next', micConnected: true, serverIncarnation: 'server' },
  });
  assert.equal(f.events.filter(e => e.type === 'relay-choir-stop-secondary-capture').length, 1);
  f.accept();
  assert.equal(f.leave.hidden, true);
  assert.equal(f.events.at(-1)?.detail?.type, 'choir-secondary-withdraw');
});

test('a join acknowledged for another Mic owner never activates the guest controls', async () => {
  const f = await choirPage();
  f.join();
  f.emit('relay-choir-message', {
    type: 'choir-secondary-consent-status', status: 'accepted', secondaryId: 'b', primaryId: 'next',
  });
  assert.equal(f.leave.hidden, true);
  assert.ok(f.events.some(e => e.detail?.type === 'choir-secondary-withdraw'));
});

test('refused or cancelled microphone preparation leaves the current singer in place', async () => {
  const f = await choirPage();
  f.emit('relay-product-status', { room: { duet: { secondaryId: 'incumbent' } } });
  f.tap();
  assert.equal(f.notice.textContent, 'choir.preparingMic');
  f.emit('relay-choir-media-connection', { state: 'capture-failed', reason: 'permission-denied' });
  assert.equal(f.notice.textContent, 'voice.permissionRequired');
  assert.equal(f.events.some(e => e.type === 'relay-choir-command'), false);
  f.tap();
  f.advance(20_000);
  f.ready();
  assert.equal(f.notice.textContent, 'choir.captureTimedOut');
  assert.equal(f.events.some(e => e.type === 'relay-choir-command'), false);
  f.tap();
  f.presence(false);
  f.ready();
  f.presence(true);
  assert.equal(f.events.some(e => e.type === 'relay-choir-command'), false);
  f.tap();
  f.emit('relay-choir-message', { type: 'choir-consent-rejected' });
  f.ready();
  f.ready();
  assert.deepEqual(f.events.filter(e => e.type === 'relay-choir-command').map(e => e.detail.type), ['choir-secondary-join']);
});

test('a pending takeover remembers the seat the singer saw before granting microphone access', async () => {
  const f = await choirPage();
  const occupant = (secondaryId: string) => f.emit('relay-product-status', { room: { duet: { secondaryId } } });
  occupant('first');
  f.tap();
  occupant('next');
  f.ready();
  assert.equal(f.events.at(-1)?.detail.expectedSecondaryId, 'first');
  f.emit('relay-choir-message', { type: 'choir-consent-rejected', reason: 'seat-changed' });
  assert.equal(f.notice.textContent, 'choir.seatChanged');
  f.join();
  assert.equal(f.events.at(-1)?.detail.expectedSecondaryId, 'next');
});

test('an unanswered or refused join explains why capture stopped and allows retry', async () => {
  const f = await choirPage();
  f.join();
  f.advance(8_000);
  assert.equal(f.notice.textContent, 'choir.joinTimedOut');
  assert.equal(f.leave.hidden, true);
  f.emit('relay-choir-message', { type: 'choir-consent-rejected', reason: 'invalid-or-stale' });
  assert.equal(f.notice.textContent, 'choir.joinTimedOut', 'the cleanup reply preserves the timeout explanation');
  f.join();
  f.emit('relay-choir-message', { type: 'choir-consent-rejected', reason: 'invalid-or-stale' });
  assert.equal(f.notice.textContent, 'choir.joinRefused');
  f.join();
  f.accept();
  assert.equal(f.notice.hidden, true);
  assert.equal(f.leave.hidden, false);
});
