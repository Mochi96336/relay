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

test('recording blocker uses the authoritative ProductIssue cause and rerenders locale', async ({ page }) => {
  await openState(page, 'recording-blocked');

  await expect(page.locator('#start-recording')).toBeHidden();
  await expect(page.locator('#recording-status')).toHaveText('伴奏音訊中斷');
  await expect(page.locator('#recording-status')).not.toHaveText('目前無法錄音');

  await page.evaluate(() => window.relayI18n.setLocale('en', { persist: false }));
  await expect(page.locator('#recording-status')).toHaveText('Backing track interrupted');
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

test('System issue cause, impact and recovery rerender through product i18n', async ({ page }) => {
  await openState(page, 'system-issue');

  const issue = page.locator('#system-product .system-issue');
  await expect(page.locator('#system-panel')).toHaveJSProperty('open', true);
  await expect(issue).toHaveCount(1);
  await expect(issue.locator('strong')).toHaveText('麥克風音訊中斷');
  await expect(issue.locator('p')).toHaveText('Mic 仍連線，但音訊已停止送達。');
  await expect(issue.locator('.system-issue-meta span').first()).toHaveText('影響：人聲 · 錄音');
  await expect(issue.locator('.system-issue-recovery')).toHaveText('重新連接 Mic 後再試一次。');

  await page.evaluate(() => window.relayI18n.setLocale('en', { persist: false }));
  await expect(issue.locator('strong')).toHaveText('Microphone audio interrupted');
  await expect(issue.locator('p')).toHaveText('The Mic is connected, but audio stopped arriving.');
  await expect(issue.locator('.system-issue-meta span').first()).toHaveText('Affects：Voice · Recording');
  await expect(issue.locator('.system-issue-recovery')).toHaveText('Reconnect the Mic, then try again.');
});

test('recoverable Song copy rerenders through product i18n', async ({ page }) => {
  await openState(page, 'listener');

  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('relay:playback-view', {
      detail: {
        role: 'observer',
        timeline: {
          videoId: 'PZGwZwGQTlk',
          videoTitle: '林俊傑 JJ Lin－偉大的渺小',
          videoAuthor: 'JJ Lin 林俊傑',
          state: 1,
          serverTime: 102,
          duration: 311,
          handoffState: 'idle',
          playbackLeaderParticipantId: 'visual-owner',
          playbackTransportId: 'visual-playback',
          playbackGeneration: 1,
          leaderConnected: false,
          leaderFresh: false,
          ageMs: 7_000,
        },
        isMicOwner: false,
        isMicFree: false,
      },
    }));
  });

  await expect(page.locator('.song-stage')).toHaveAttribute('data-playback-health', 'disconnected');
  await expect(page.locator('#song-device-note')).toBeVisible();
  await expect(page.locator('#song-device-note')).toHaveText('播放主控已失聯');
  await expect(page.locator('.song-observer-status')).toBeVisible();
  await expect(page.locator('.song-observer-status')).toHaveText('播放已中斷');

  await page.evaluate(() => window.relayI18n.setLocale('en', { persist: false }));
  await expect(page.locator('#song-device-note')).toHaveText('Playback controller unavailable');
  await expect(page.locator('.song-observer-status')).toHaveText('Playback interrupted');
});

test('Mic presenter keeps the same product copy when locale changes without a Live override', async ({ page }) => {
  await openState(page, 'takeover');

  await page.evaluate(() => window.relayI18n.setLocale('en', { persist: false }));
  await expect(page.locator('#mic-takeover-copy')).toHaveText('Mellow Rabbit 57 is using Mic.');
  await expect(page.locator('#confirm-takeover')).toHaveText('Take over Mic');
  await expect(page.locator('#cancel-takeover')).toHaveText('Cancel');

  await page.evaluate(() => window.relayI18n.setLocale('zh-Hant', { persist: false }));
  await expect(page.locator('#mic-takeover-copy')).toHaveText('目前是 Mellow Rabbit 57 在使用 Mic。');
  await expect(page.locator('#confirm-takeover')).toHaveText('接手 Mic');

  await openState(page, 'singer');
  await page.evaluate(() => window.relayI18n.setLocale('en', { persist: false }));
  await expect(page.locator('#release-mic')).toHaveText('Release Mic');
});

test('registered Live feature messages rerender through the base provider', async ({ page }) => {
  await openState(page, 'listener');
  await expect(page.locator('#local-listen-label')).toHaveText('房間聲音');
  await page.evaluate(() => window.relayI18n.setLocale('en', { persist: false }));
  await expect(page.locator('#local-listen-label')).toHaveText('Room sound');

  await openState(page, 'people');
  await page.evaluate(() => window.relayI18n.setLocale('en', { persist: false }));
  await expect(page.locator('.people-popover-title')).toHaveText('In the room');

  await openState(page, 'recording');
  await page.evaluate(() => window.relayI18n.setLocale('en', { persist: false }));
  await expect(page.locator('#stop-recording')).toHaveText('Stop recording');
});
