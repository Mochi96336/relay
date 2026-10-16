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
    await import('/choir-consent-ui.js');
    window.dispatchEvent(new CustomEvent('relay-presence-state', {
      detail: {
        authorityFresh: true,
        session: {
          micOwnerId, micConnected: micOwnerId !== null,
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
  window.dispatchEvent(new CustomEvent('relay-choir-consent-availability', { detail: { available: true } }));
  window.dispatchEvent(new CustomEvent('relay-choir-media-mode', { detail: { enabled: true } }));
});
const consent = (page, detail) => page.evaluate(detail => window.dispatchEvent(
  new CustomEvent('relay-choir-consent-message', { detail })), detail);
const duet = (page, secondaryId) => page.evaluate(secondaryId => window.dispatchEvent(
  new CustomEvent('relay-product-status', {
    detail: { type: 'product-status', room: { duet: secondaryId ? { secondaryId, state: 'singing' } : null } },
  })), secondaryId);
const accepted = { type: 'choir-secondary-consent-status', status: 'accepted', secondaryId: 'singerB', joined: true };

test('normal N=1 shows no second Mic controls without explicit server availability', async ({ page }) => {
  await openFixture(page, 'owner', 'owner');
  await expect(page.locator('#choir-invite-open')).toBeHidden();
  await expect(page.locator('#choir-withdraw')).toBeHidden();
  await expect(page.locator('#choir-consent-status')).toBeHidden();
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
  await expect(page.locator('#choir-consent-status')).toBeHidden();

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
  await expect(page.locator('#choir-consent-status')).toBeHidden();
  await expect(page.locator('#choir-withdraw')).toBeVisible();
  await expect(open).toBeHidden();
  await expect(page.locator('#start-publisher')).toBeHidden();
  await page.locator('#choir-withdraw').click();
  expect((await page.evaluate(() => window.__choirSent)).at(-1)).toEqual({ type: 'choir-secondary-withdraw' });
  await consent(page, { type: 'choir-secondary-consent-status', status: 'withdrawn', secondaryId: 'singerB' });
  await expect(page.locator('#choir-withdraw')).toBeHidden();
  await expect(open).toBeVisible();
  await expect(open).toBeEnabled();
  await expect.poll(() => page.evaluate(() =>
    document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('while someone else sings second, the button takes over, and the one replaced is told why', async ({ page }) => {
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
  await expect(page.locator('#choir-consent-status')).toBeVisible();
  await expect(page.locator('#choir-consent-status')).toHaveText('副 Mic 被別人接手了。');
  await expect(page.locator('#choir-withdraw')).toBeHidden();
  // B can take it straight back.
  await duet(page, 'singerC');
  await expect(page.locator('#choir-invite-open')).toHaveText('接手副 Mic');
  await expect(page.locator('#choir-invite-open')).toBeEnabled();
});

test('a refused or ended second Mic says why in one line, and joining again clears it', async ({ page }) => {
  await openFixture(page, 'singerB', 'owner');
  await enable(page);
  const open = page.locator('#choir-invite-open');
  await open.click();
  await consent(page, { type: 'choir-consent-rejected', reason: 'invalid-or-stale' });
  await expect(page.locator('#choir-consent-status')).toContainText('目前無法加入');
  await expect(open).toBeEnabled();

  await open.click();
  await expect(page.locator('#choir-consent-status')).toBeHidden();
  await consent(page, accepted);
  await consent(page, { type: 'choir-secondary-consent-status', status: 'revoked', secondaryId: 'singerB', reason: 'scope-or-authority-changed' });
  await expect(page.locator('#choir-consent-status')).toContainText('副 Mic 已結束');
  await expect(page.locator('#choir-withdraw')).toBeHidden();
  await expect(open).toBeVisible();

  await page.evaluate(() => window.dispatchEvent(new CustomEvent(
    'relay-choir-consent-availability', { detail: { available: false } })));
  await expect(open).toBeHidden();
  await expect(page.locator('#choir-withdraw')).toBeHidden();
});
