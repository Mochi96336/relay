import { expect, test } from '@playwright/test';

const BASE = process.env.RELAY_INTERACTION_URL ?? 'http://127.0.0.1:4173/';

test.use({ viewport: { width: 390, height: 844 } });

async function openFixture(page, participantId, micOwnerId = null) {
  await page.goto(new URL('__live-visual.html', BASE).href);
  await page.evaluate(async ({ participantId, micOwnerId }) => {
    window.relayParticipantId = participantId;
    window.__choirSent = [];
    // The join tap really starts capture now. Keep it pending: these tests are
    // about the panel, and a fixture microphone failing would leave the join.
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

test('normal N=1 shows no Choir invitation UI without explicit server availability', async ({ page }) => {
  await openFixture(page, 'owner', 'owner');
  await expect(page.locator('#choir-invite-open')).toBeHidden();
  await expect(page.locator('#choir-consent-panel')).toBeHidden();
  await expect.poll(() => page.evaluate(() =>
    document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('only someone other than the Mic owner sees + Second Mic, and one tap joins and starts capture', async ({ page }) => {
  const enable = () => page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('relay-choir-consent-availability', { detail: { available: true } }));
    window.dispatchEvent(new CustomEvent('relay-choir-media-mode', { detail: { enabled: true } }));
  });
  await openFixture(page, 'owner', 'owner');
  await enable();
  await expect(page.locator('#choir-invite-open')).toBeHidden();

  await openFixture(page, 'singerB', null);
  await enable();
  await expect(page.locator('#choir-invite-open')).toBeHidden();

  await openFixture(page, 'singerB', 'owner');
  await enable();
  await page.evaluate(() => {
    window.__choirCaptureStarts = 0;
    window.addEventListener('relay-choir-start-secondary-capture',
      () => { window.__choirCaptureStarts++; });
  });
  const open = page.locator('#choir-invite-open');
  await expect(open).toBeVisible();
  await expect(page.locator('#choir-room-begin')).toBeHidden();
  await expect(page.locator('#choir-secondary-connect')).toBeHidden();
  await open.click();
  expect(await page.evaluate(() => ({
    starts: window.__choirCaptureStarts, commands: window.__choirSent,
  }))).toEqual({ starts: 1, commands: [{ type: 'choir-secondary-join' }] });
  await expect(page.locator('#choir-consent-status')).toContainText('正在加入副 Mic');
  await expect(page.locator('#choir-consent-note')).toContainText('兩人都完成時間對齊後');

  await page.evaluate(() => window.dispatchEvent(new CustomEvent('relay-choir-consent-message', {
    detail: { type: 'choir-secondary-consent-status', status: 'accepted',
      secondaryId: 'singerB', primaryId: 'owner', joined: true },
  })));
  // Joined: the heading carries the duet's progress; the panel only offers leaving.
  await expect(page.locator('#choir-consent-status')).toHaveText('');
  await expect(page.locator('#choir-consent-status')).toBeHidden();
  await expect(page.locator('#choir-withdraw')).toBeVisible();
  await expect(open).toBeHidden();
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
  await expect(page.locator('#choir-invitation-copy')).toContainText('按下連接後才會開啟你的麥克風');
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
    'relay-choir-consent-message', {
      detail: {
        type: 'choir-secondary-consent-status', status: 'withdrawn',
        secondaryId: 'singerB', roomEpoch: 3,
      },
    },
  )));
  await expect(page.locator('#choir-withdraw')).toBeHidden();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent(
    'relay-choir-consent-availability', { detail: { available: false } },
  )));
  await expect(page.locator('#choir-consent-panel')).toBeHidden();
  await expect(page.locator('#choir-withdraw')).toBeHidden();
});

test('a refused join stays on screen until closed, and + Second Mic hides while someone else is in', async ({ page }) => {
  await openFixture(page, 'singerB', 'owner');
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('relay-choir-consent-availability', { detail: { available: true } }));
    window.dispatchEvent(new CustomEvent('relay-choir-media-mode', { detail: { enabled: true } }));
  });
  await page.locator('#choir-invite-open').click();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('relay-choir-consent-message', {
    detail: { type: 'choir-consent-rejected', reason: 'invalid-or-stale' },
  })));
  await expect(page.locator('#choir-consent-panel')).toBeVisible();
  await expect(page.locator('#choir-consent-status')).toContainText('目前無法加入');
  await page.locator('#choir-consent-close').click();
  await expect(page.locator('#choir-consent-panel')).toBeHidden();
  await expect(page.locator('#choir-invite-open')).toBeVisible();

  await page.evaluate(() => window.dispatchEvent(new CustomEvent('relay-product-status', {
    detail: { type: 'product-status', room: { duet: { secondaryId: 'someone-else', state: 'singing' } } },
  })));
  await expect(page.locator('#choir-invite-open')).toBeHidden();
});

test('when the server ends the second Mic, the panel says why', async ({ page }) => {
  await openFixture(page, 'singerB', 'owner');
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('relay-choir-consent-availability', { detail: { available: true } }));
    window.dispatchEvent(new CustomEvent('relay-choir-media-mode', { detail: { enabled: true } }));
  });
  await page.locator('#choir-invite-open').click();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('relay-choir-consent-message', {
    detail: { type: 'choir-secondary-consent-status', status: 'accepted', secondaryId: 'singerB', joined: true },
  })));
  await expect(page.locator('#choir-withdraw')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('relay-choir-consent-message', {
    detail: { type: 'choir-secondary-consent-status', status: 'revoked', secondaryId: 'singerB', reason: 'scope-or-authority-changed' },
  })));
  await expect(page.locator('#choir-consent-panel')).toBeVisible();
  await expect(page.locator('#choir-consent-status')).toContainText('副 Mic 已結束');
  await expect(page.locator('#choir-withdraw')).toBeHidden();
  await page.locator('#choir-consent-close').click();
  await expect(page.locator('#choir-consent-panel')).toBeHidden();
});

test('the Mic owner can end its second Mic, and B is told the owner ended it', async ({ page }) => {
  const enable = () => page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('relay-choir-consent-availability', { detail: { available: true } }));
    window.dispatchEvent(new CustomEvent('relay-choir-media-mode', { detail: { enabled: true } }));
  });
  await openFixture(page, 'owner', 'owner');
  await enable();
  const dismiss = page.locator('#choir-dismiss');
  await expect(dismiss).toBeHidden();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('relay-product-status', {
    detail: { type: 'product-status', room: { mic: { ownerId: 'owner' }, duet: { secondaryId: 'singerB', state: 'singing' } } },
  })));
  await expect(dismiss).toBeVisible();
  await expect(dismiss).toHaveText('結束副 Mic');
  await dismiss.click();
  expect((await page.evaluate(() => window.__choirSent)).at(-1)).toEqual({ type: 'choir-secondary-dismiss' });

  await openFixture(page, 'singerB', 'owner');
  await enable();
  await page.locator('#choir-invite-open').click();
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('relay-choir-consent-message', {
      detail: { type: 'choir-secondary-consent-status', status: 'accepted', secondaryId: 'singerB', joined: true },
    }));
    window.dispatchEvent(new CustomEvent('relay-choir-consent-message', {
      detail: { type: 'choir-secondary-consent-status', status: 'revoked', secondaryId: 'singerB', reason: 'dismissed' },
    }));
  });
  await expect(page.locator('#choir-consent-status')).toContainText('主唱結束了副 Mic');
});
