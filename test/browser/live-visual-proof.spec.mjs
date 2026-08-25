import { expect, test } from '@playwright/test';

const base = process.env.RELAY_INTERACTION_URL ?? 'http://127.0.0.1:4173/';

async function openState(page, state) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(new URL(`__live-visual.html?state=${state}`, base).href);
  await page.waitForFunction(() => window.__relayVisualReady === true);
  await page.waitForTimeout(40);
  expect(errors, `page errors in ${state}`).toEqual([]);
}

test('listener state is painted by production Song, Mic, People and Room sound presenters', async ({ page }) => {
  await openState(page, 'listener');

  await expect(page.locator('#live-state-title')).toHaveText('Mellow Rabbit 57');
  await expect(page.locator('#live-state-detail')).toHaveText('正在唱');
  await expect(page.locator('#start-publisher')).toHaveText('接手 Mic');
  await expect(page.locator('#listen-toggle .room-sound-icon')).toHaveCount(1);
  await expect(page.locator('#listen-toggle')).not.toContainText('暫停中');
  await expect(page.locator('#song-observer')).toBeVisible();
  await expect(page.locator('#room-song-state')).toContainText('偉大的渺小');
});

test('singer state uses production forced Room sound and Mic ownership projection', async ({ page }) => {
  await openState(page, 'singer');

  await expect(page.locator('#live-state-title')).toHaveText('你正在唱');
  await expect(page.locator('#release-mic')).toBeVisible();
  await expect(page.locator('#release-mic')).toHaveText('放 Mic');
  await expect(page.locator('#listen-toggle .room-sound-icon')).toHaveCount(1);
  await expect(page.locator('#listen-toggle')).not.toContainText('暫停中');
  await expect(page.locator('#listen-adjust-state')).toHaveText('唱歌時暫停');
  await expect(page.locator('.song-stage')).toHaveAttribute('data-playback-role', 'holder');
  await expect(page.locator('.youtube-player-shell')).toBeVisible();
});

test('recording and reconnecting states come from the recording presenter', async ({ page }) => {
  await openState(page, 'recording');
  await expect(page.locator('#stop-recording')).toBeVisible();
  await expect(page.locator('#recording-status')).toContainText('● 0:18');

  await openState(page, 'reconnecting');
  await expect(page.locator('#live-state-title')).toHaveText('連線中…');
  await expect(page.locator('#recording-status')).toHaveText('重新連線中…');
});

test('takeover, People, More and System use production DOM and presenter state', async ({ page }) => {
  await openState(page, 'takeover');
  await expect(page.locator('#mic-takeover')).toBeVisible();
  await expect(page.locator('#mic-takeover-copy')).toHaveText('目前是 Mellow Rabbit 57 在使用 Mic。');

  await openState(page, 'people');
  await expect(page.locator('.people-menu')).toHaveJSProperty('open', true);
  await expect(page.locator('.participant-row')).toHaveCount(2);
  await expect(page.locator('.people-popover-title')).toHaveText('房間裡');

  await openState(page, 'more');
  await expect(page.locator('#room-more')).toHaveJSProperty('open', true);
  await expect(page.locator('#open-system')).toBeVisible();

  await openState(page, 'system');
  await expect(page.locator('#system-panel')).toHaveJSProperty('open', true);
  await expect(page.locator('#system-product')).toBeVisible();
  await expect(page.locator('#system-product')).toContainText('系統正常');
  await expect(page.locator('#system-product')).toContainText('目前沒有需要處理的問題。');
});
