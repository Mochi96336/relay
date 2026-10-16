import { expect, test } from '@playwright/test';

const BASE = process.env.RELAY_INTERACTION_URL ?? 'http://127.0.0.1:4173/';

test.use({ viewport: { width: 390, height: 844 } });

async function openFixture(page, participantId, micOwnerId = null) {
  await page.goto(new URL('__live-visual.html', BASE).href);
  await page.evaluate(async ({ participantId, micOwnerId }) => {
    window.relayParticipantId = participantId;
    window.__choirSent = [];
    // The join tap really starts capture now. Keep it pending: these tests are
    // about the controls, and a fixture microphone failing would leave the join.
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () => new Promise(() => {});
    window.addEventListener('relay-choir-consent-command', event => {
      window.__choirSent.push(event.detail);
    });
    // The fixture keeps answering product-status without a duet; as the real
    // server does, every product-status carries the duet the test set.
    window.__fixtureDuet = null;
    window.addEventListener('relay-product-status', event => {
      if (event.detail?.room) event.detail.room.duet = window.__fixtureDuet;
    });
    const mix = await import('/mix-controls.js');
    window.__mixControls = mix;
    window.__primaryMixChanges = 0;
    mix.listenForSingerInput({ onMix: () => window.__primaryMixChanges++ });
    await import('/choir-consent-ui.js');
    window.dispatchEvent(new CustomEvent('relay-presence-state', {
      detail: {
        authorityFresh: true,
        session: {
          micOwnerId, micConnected: micOwnerId !== null, serverIncarnation: 'fixture-server',
          participants: [
            { id: 'owner', nickname: 'Lead Singer', connected: true },
            { id: 'singerB', nickname: 'Second Singer', connected: true },
          ],
        },
      },
    }));
  }, { participantId, micOwnerId });
}

const enable = page => page.evaluate(() => {
  window.dispatchEvent(new CustomEvent('relay-choir-consent-availability', { detail: { available: true, resumeSupported: true } }));
  window.dispatchEvent(new CustomEvent('relay-choir-media-mode', { detail: { enabled: true } }));
});
const consent = (page, detail) => page.evaluate(detail => window.dispatchEvent(
  new CustomEvent('relay-choir-consent-message', { detail })), detail);
const duet = (page, secondaryId) => page.evaluate(secondaryId => {
  window.__fixtureDuet = secondaryId ? { secondaryId, state: 'singing' } : null;
  window.dispatchEvent(new CustomEvent('relay-product-status', {
    detail: { type: 'product-status', room: {} },
  }));
}, secondaryId);
const accepted = { type: 'choir-secondary-consent-status', status: 'accepted', secondaryId: 'singerB', joined: true };

test('normal N=1 shows no second Mic controls without explicit server availability', async ({ page }) => {
  await openFixture(page, 'owner', 'owner');
  await expect(page.locator('#choir-invite-open')).toBeHidden();
  await expect(page.locator('#choir-withdraw')).toBeHidden();
  await expect.poll(() => page.evaluate(() =>
    document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('only someone other than the Mic owner sees + Second Mic, and one tap joins and starts capture', async ({ page }) => {
  await openFixture(page, 'owner', 'owner');
  await enable(page);
  await expect(page.locator('#choir-invite-open')).toBeHidden();
  // The Mic owner has nothing to manage: no card and no way to remove B.
  await duet(page, 'singerB');
  await expect(page.locator('#choir-invite-open')).toBeHidden();

  await openFixture(page, 'singerB', null);
  await enable(page);
  await expect(page.locator('#choir-invite-open')).toBeHidden();

  await openFixture(page, 'singerB', 'owner');
  await enable(page);
  await page.evaluate(() => {
    window.__choirCaptureStarts = 0;
    window.addEventListener('relay-choir-start-secondary-capture',
      () => { window.__choirCaptureStarts++; });
  });
  const open = page.locator('#choir-invite-open');
  await expect(open).toBeVisible();
  await expect(open).toHaveText('+ 副 Mic');
  await open.click();
  expect(await page.evaluate(() => ({
    starts: window.__choirCaptureStarts, commands: window.__choirSent,
  }))).toEqual({ starts: 1, commands: [{ type: 'choir-secondary-join' }] });
  await expect(open).toBeDisabled();

  await consent(page, accepted);
  // Joined: the heading carries the duet's progress; the Mic row only offers leaving.
  await expect(page.locator('#choir-withdraw')).toBeVisible();
  const buttonStyles = await page.evaluate(() => {
    const properties = ['borderRadius', 'borderWidth', 'backgroundColor', 'padding', 'fontSize', 'fontWeight', 'color'];
    const style = id => { const css = getComputedStyle(document.getElementById(id));
      return properties.map(property => css[property]); };
    return { release: style('release-mic'), leave: style('choir-withdraw') };
  });
  expect(buttonStyles.leave).toEqual(buttonStyles.release);
  await expect(open).toBeHidden();
  await expect(page.locator('#start-publisher')).toBeHidden();
  // B's own Mic gain, in the same row the Mic owner has.
  await expect(page.locator('.mic-live-control')).toBeVisible();
  await expect(page.locator('.mic-live-control')).toHaveCount(1);
  await expect(page.locator('.mic-live-control summary span')).toHaveText('Mic');
  await expect(page.locator('#mic-gain')).toBeEnabled();
  await page.locator('#mic-gain').fill('12');
  await expect(page.locator('#mic-gain-value')).toHaveText('+12 dB');
  await expect.poll(() => page.evaluate(() => window.__choirSent.at(-1)))
    .toEqual({ type: 'choir-secondary-gain', micGainDb: 12 });
  await page.evaluate(() => {
    window.__mixControls.acceptMixSettings({ micGainDb: 35 });
    window.__mixControls.setSingerControlsEnabled(false);
    window.__mixControls.restoreLastKnownControl('set-mix');
  });
  await expect(page.locator('#mic-gain')).toHaveValue('12');
  await expect(page.locator('#mic-gain')).toBeEnabled();
  expect(await page.evaluate(() => window.__primaryMixChanges)).toBe(0);

  await page.locator('#choir-withdraw').click();
  expect((await page.evaluate(() => window.__choirSent)).at(-1)).toEqual({ type: 'choir-secondary-withdraw', reason: 'user' });
  await consent(page, { type: 'choir-secondary-consent-status', status: 'withdrawn', secondaryId: 'singerB' });
  await expect(page.locator('#choir-withdraw')).toBeHidden();
  await expect(open).toBeVisible();
  await expect(open).toBeEnabled();
  await expect(page.locator('.mic-live-control')).toBeHidden();
  await expect(page.locator('#mic-gain')).toBeDisabled();
  await expect(page.locator('#mic-gain')).toHaveValue('35');
  await expect.poll(() => page.evaluate(() =>
    document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('while someone else sings second, the button takes over without an extra status row', async ({ page }) => {
  await openFixture(page, 'singerC', 'owner');
  await enable(page);
  await duet(page, 'singerB');
  const open = page.locator('#choir-invite-open');
  await expect(open).toBeVisible();
  await expect(open).toHaveText('接手副 Mic');
  // A re-translation of the page keeps the takeover label.
  await page.evaluate(() => window.relayI18n.applyStatic());
  await expect(open).toHaveText('接手副 Mic');
  await open.click();
  expect((await page.evaluate(() => window.__choirSent)).at(-1)).toEqual({ type: 'choir-secondary-join' });

  await openFixture(page, 'singerB', 'owner');
  await enable(page);
  await page.locator('#choir-invite-open').click();
  await consent(page, accepted);
  await expect(page.locator('#choir-withdraw')).toBeVisible();
  await consent(page, { type: 'choir-secondary-consent-status', status: 'revoked', secondaryId: 'singerB', reason: 'replaced' });
  await expect(page.locator('#choir-withdraw')).toBeHidden();
  // B can take it straight back.
  await duet(page, 'singerC');
  await expect(page.locator('#choir-invite-open')).toHaveText('接手副 Mic');
  await expect(page.locator('#choir-invite-open')).toBeEnabled();
});

test('a refused or ended second Mic restores its join button without an extra status row', async ({ page }) => {
  await openFixture(page, 'singerB', 'owner');
  await enable(page);
  const open = page.locator('#choir-invite-open');
  await expect(page.locator('#choir-consent-status')).toHaveCount(0);
  await open.click();
  await consent(page, { type: 'choir-consent-rejected', reason: 'invalid-or-stale' });
  await expect(open).toBeEnabled();

  await open.click();
  await consent(page, accepted);
  await consent(page, { type: 'choir-secondary-consent-status', status: 'revoked', secondaryId: 'singerB', reason: 'scope-or-authority-changed' });
  await expect(page.locator('#choir-withdraw')).toBeHidden();
  await expect(open).toBeVisible();

  await page.evaluate(() => window.dispatchEvent(new CustomEvent(
    'relay-choir-consent-availability', { detail: { available: false } })));
  await expect(open).toBeHidden();
  await expect(page.locator('#choir-withdraw')).toBeHidden();
});


test('repeated room announcements preserve B media while a new room reconnects', async ({ page }) => {
  await openFixture(page, 'singerB', 'owner');
  await enable(page);
  const result = await page.evaluate(async () => {
    const { ChoirSecondaryCapture } = await import('/choir-secondary-capture.js');
    ChoirSecondaryCapture.prototype.prepare = async function () { this.rate = 48000; return this.rate; };
    ChoirSecondaryCapture.prototype.attach = () => true;
    window.relayParticipantCapability = 'fixture-capability';
    window.relayNickname = 'B';
    const sockets = [];
    class MediaSocket extends EventTarget {
      static OPEN = 1; static CLOSED = 3;
      readyState = 0;
      closes = 0;
      constructor() {
        super(); sockets.push(this);
        queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); });
      }
      send(raw) {
        const message = JSON.parse(raw);
        const reply = message.type === 'participant-authenticate'
          ? { type: 'participant-authenticated', participantId: 'singerB' }
          : { type: 'choir-secondary-media-registered', roomEpoch: 1, awaitingContent: true, sampleRate: 48000 };
        queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(reply) })));
      }
      close() { this.closes++; this.readyState = 3; this.dispatchEvent(new Event('close')); }
    }
    window.WebSocket = MediaSocket;
    const message = detail => window.dispatchEvent(new CustomEvent('relay-choir-media-message', { detail }));
    window.dispatchEvent(new Event('relay-choir-start-secondary-capture'));
    await Promise.resolve();
    const room = { type: 'choir-room-ready', roomEpoch: 1 };
    message(room);
    message(room); // Still awaiting the one-use claim.
    message({ type: 'choir-secondary-media-claim', roomEpoch: 1, claimToken: 'a'.repeat(64) });
    message(room); // Socket is opening.
    await new Promise(resolve => setTimeout(resolve, 0));
    message(room); // Media is registered.
    message({ ...room, roomEpoch: 0 });
    const preserved = { sockets: sockets.length, closes: sockets[0].closes,
      claims: window.__choirSent.filter(m => m.type === 'choir-secondary-media-claim-request').length };
    message({ ...room, roomEpoch: 2 });
    const replaced = { closes: sockets[0].closes,
      claims: window.__choirSent.filter(m => m.type === 'choir-secondary-media-claim-request').length };
    return { preserved, replaced };
  });
  expect(result.preserved).toEqual({ sockets: 1, closes: 0, claims: 1 });
  expect(result.replaced).toEqual({ closes: 1, claims: 2 });
});


const presence = (page, authorityFresh, overrides = {}) => page.evaluate(({ authorityFresh, overrides }) => {
  window.dispatchEvent(new CustomEvent('relay-presence-state', { detail: {
    authorityFresh, session: { micOwnerId: 'owner', micConnected: true,
      serverIncarnation: 'fixture-server', ...overrides },
  } }));
}, { authorityFresh, overrides });

test('B survives a brief control disconnect and resumes without another microphone tap', async ({ page }) => {
  await openFixture(page, 'singerB', 'owner');
  await enable(page);
  await page.locator('#choir-invite-open').click();
  await consent(page, accepted);
  await page.evaluate(() => {
    window.__captureStops = 0;
    window.addEventListener('relay-choir-stop-secondary-capture', () => window.__captureStops++);
  });
  await presence(page, false);
  await expect(page.locator('#choir-withdraw')).toBeVisible();
  await expect(page.locator('#choir-invite-open')).toBeHidden();
  expect(await page.evaluate(() => window.__captureStops)).toBe(0);
  await presence(page, true);
  expect(await page.evaluate(() => window.__choirSent.at(-1))).toEqual({
    type: 'choir-secondary-join', resume: true, expectedPrimaryId: 'owner',
  });
  await consent(page, accepted);
  await expect(page.locator('#choir-withdraw')).toBeVisible();
  expect(await page.evaluate(() => window.__captureStops)).toBe(0);
});

for (const change of [{ micOwnerId: 'another-owner' }, { serverIncarnation: 'another-server' }]) {
  test(`a changed room scope cannot silently rejoin B: ${JSON.stringify(change)}`, async ({ page }) => {
    await openFixture(page, 'singerB', 'owner');
    await enable(page);
    await page.locator('#choir-invite-open').click();
    await consent(page, accepted);
    await presence(page, false);
    await presence(page, true, change);
    await expect(page.locator('#choir-withdraw')).toBeHidden();
    expect(await page.evaluate(() => window.__choirSent.some(m => m.resume))).toBe(false);
  });
}

test('leaving during reconnect cancels B resume', async ({ page }) => {
  await openFixture(page, 'singerB', 'owner');
  await enable(page);
  await page.locator('#choir-invite-open').click();
  await consent(page, accepted);
  await presence(page, false);
  await page.locator('#choir-withdraw').click();
  await presence(page, true);
  await expect(page.locator('#choir-withdraw')).toBeHidden();
  expect(await page.evaluate(() => window.__choirSent.some(m => m.resume))).toBe(false);
});

test('B stops capture after the control recovery deadline', async ({ page }) => {
  await openFixture(page, 'singerB', 'owner');
  await enable(page);
  await page.locator('#choir-invite-open').click();
  await consent(page, accepted);
  await page.clock.install();
  await presence(page, false);
  await page.clock.fastForward(15_001);
  await expect(page.locator('#choir-withdraw')).toBeHidden();
  await presence(page, true);
  expect(await page.evaluate(() => window.__choirSent.some(m => m.resume))).toBe(false);
});

test('capture failure while joining cannot be revived by a late accepted reply', async ({ page }) => {
  await openFixture(page, 'singerB', 'owner');
  await enable(page);
  await page.locator('#choir-invite-open').click();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('relay-choir-media-connection', {
    detail: { state: 'capture-failed', reason: 'input-gap' },
  })));
  expect(await page.evaluate(() => window.__choirSent.at(-1))).toEqual({
    type: 'choir-secondary-withdraw', reason: 'capture-failed:input-gap',
  });
  await consent(page, accepted);
  await expect(page.locator('#choir-withdraw')).toBeHidden();
  await expect(page.locator('#choir-invite-open')).toBeEnabled();
  expect(await page.evaluate(() => window.__choirSent.at(-1))).toEqual({
    type: 'choir-secondary-withdraw', reason: 'join-cancelled',
  });
});

test('a timed out join cannot be revived by a late accepted reply', async ({ page }) => {
  await openFixture(page, 'singerB', 'owner');
  await enable(page);
  await page.clock.install();
  await page.locator('#choir-invite-open').click();
  await page.clock.fastForward(8_001);
  await consent(page, accepted);
  await expect(page.locator('#choir-withdraw')).toBeHidden();
  await expect(page.locator('#choir-invite-open')).toBeEnabled();
});

test('a cancelled permission request cannot block or cancel a newer capture attempt', async ({ page }) => {
  await openFixture(page, 'singerB', 'owner');
  await enable(page);
  const result = await page.evaluate(async () => {
    const { ChoirSecondaryCapture } = await import('/choir-secondary-capture.js');
    let attempts = 0;
    let rejectOld;
    ChoirSecondaryCapture.prototype.prepare = function () {
      attempts++;
      return attempts === 1 ? new Promise((_, reject) => { rejectOld = reject; }) : new Promise(() => {});
    };
    const notify = type => window.dispatchEvent(new Event(type));
    notify('relay-choir-start-secondary-capture');
    notify('relay-choir-stop-secondary-capture');
    notify('relay-choir-start-secondary-capture');
    let failures = 0;
    window.addEventListener('relay-choir-media-connection', event => {
      if (event.detail?.state === 'capture-failed') failures++;
    });
    rejectOld(new Error('old permission request was cancelled'));
    await new Promise(resolve => setTimeout(resolve, 0));
    notify('relay-choir-start-secondary-capture');
    return { attempts, failures };
  });
  expect(result).toEqual({ attempts: 2, failures: 0 });
});
