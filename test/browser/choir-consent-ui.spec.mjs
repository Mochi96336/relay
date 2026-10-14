import { expect, test } from '@playwright/test';

const BASE = process.env.RELAY_INTERACTION_URL ?? 'http://127.0.0.1:4173/';

test.use({ viewport: { width: 390, height: 844 } });

async function openFixture(page, participantId, micOwnerId = null) {
  await page.goto(new URL('__live-visual.html', BASE).href);
  await page.evaluate(async ({ participantId, micOwnerId }) => {
    window.relayParticipantId = participantId;
    window.__choirSent = [];
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

test('normal N=1 shows no Choir invitation UI without explicit server availability', async ({ page }) => {
  await openFixture(page, 'owner', 'owner');
  await expect(page.locator('#choir-invite-open')).toBeHidden();
  await expect(page.locator('#choir-consent-panel')).toBeHidden();
  await expect.poll(() => page.evaluate(() =>
    document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('mobile host can choose B and send invitation-only command without starting Mic', async ({ page }) => {
  await openFixture(page, 'owner', 'owner');
  await page.evaluate(() => window.dispatchEvent(
    new CustomEvent('relay-choir-consent-availability', { detail: { available: true } }),
  ));
  const open = page.locator('#choir-invite-open');
  await expect(open).toBeVisible();
  await open.click();
  await expect(page.locator('#choir-consent-panel')).toBeVisible();
  await expect(page.locator('#choir-secondary-person option')).toHaveCount(1);
  await expect(page.locator('#choir-secondary-person')).toHaveValue('singerB');
  await expect(page.locator('#choir-consent-note')).toContainText('尚未開放雙人收音');
  await page.locator('#choir-invite-send').click();
  const sent = await page.evaluate(() => window.__choirSent);
  expect(sent).toEqual([{ type: 'choir-secondary-invite', secondaryId: 'singerB' }]);
  await expect.poll(() => page.evaluate(() =>
    document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('mobile B explicitly accepts and withdraws; disconnect hides stale authorization controls', async ({ page }) => {
  await openFixture(page, 'singerB', 'owner');
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('relay-choir-consent-availability', {
      detail: { available: true },
    }));
    window.dispatchEvent(new CustomEvent('relay-choir-consent-message', {
      detail: {
        type: 'choir-secondary-invitation', inviteId: 'sample-id',
        primaryId: 'owner', roomEpoch: 3,
      },
    }));
  });
  await expect(page.locator('#choir-invite-open')).toBeHidden();
  await expect(page.locator('#choir-consent-panel')).toBeVisible();
  await expect(page.locator('#choir-invitation-copy')).toContainText('Lead Singer');
  await expect(page.locator('#choir-invitation-copy')).toContainText('不會開啟你的麥克風');
  await page.locator('#choir-accept').click();
  expect((await page.evaluate(() => window.__choirSent)).at(-1)).toEqual({
    type: 'choir-secondary-accept', inviteId: 'sample-id',
  });
  await page.evaluate(() => window.dispatchEvent(
    new CustomEvent('relay-choir-consent-message', {
      detail: {
        type: 'choir-secondary-consent-status', status: 'accepted',
        secondaryId: 'singerB', roomEpoch: 3,
      },
    }),
  ));
  await expect(page.locator('#choir-withdraw')).toBeVisible();
  await page.locator('#choir-withdraw').click();
  expect((await page.evaluate(() => window.__choirSent)).at(-1)).toEqual({
    type: 'choir-secondary-withdraw',
  });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent(
    'relay-choir-consent-availability', { detail: { available: false } },
  )));
  await expect(page.locator('#choir-consent-panel')).toBeHidden();
  await expect(page.locator('#choir-withdraw')).toBeHidden();
});
