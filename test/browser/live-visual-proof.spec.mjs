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

test('recording reconnect stays distinct from stale room truth on an OPEN status transport', async ({ page }) => {
  await openState(page, 'recording');
  await expect(page.locator('#stop-recording')).toBeVisible();
  await expect(page.locator('#recording-status')).toContainText('● 0:18');

  await openState(page, 'reconnecting');
  await expect(page.locator('#live-state-title')).toHaveText('未知');
  await expect(page.locator('#live-state-detail')).toHaveText('已連線');
  await expect(page.locator('#system-relay')).toHaveText('已連線');
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
  await expect(issue.locator('strong')).toHaveText('麥克風音訊不穩定');
  await expect(issue.locator('p')).toHaveText('Mic 仍連線，但音訊未能穩定送達。');
  await expect(issue.locator('.system-issue-meta span').first()).toHaveText('影響：人聲 · 錄音');
  await expect(issue.locator('.system-issue-recovery')).toHaveText('重新連接 Mic 後再試一次。');

  await page.evaluate(() => window.relayI18n.setLocale('en', { persist: false }));
  await expect(issue.locator('strong')).toHaveText('Microphone audio unstable');
  await expect(issue.locator('p')).toHaveText('The Mic is connected, but its audio is not arriving reliably.');
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

async function expectDiagnosticsTab(page, name) {
  const tab = page.locator(`#diagnostics-tab-${name}`);
  const panel = page.getByRole('tabpanel');
  await expect(tab).toBeFocused();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await expect(tab).toHaveAttribute('tabindex', '0');
  await expect(page.getByRole('tab', { selected: true })).toHaveCount(1);
  await expect(page.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);
  await expect(panel).toHaveCount(1);
  await expect(panel).toHaveAttribute('id', await tab.getAttribute('aria-controls'));
  await expect(panel).toHaveAttribute('aria-labelledby', await tab.getAttribute('id'));
  await expect(panel).toHaveAccessibleName(await tab.innerText());
}

test('Diagnostics tabs: keyboard navigation wraps, supports Home/End and keeps one Tab stop', async ({ page }) => {
  await openState(page, 'system');
  await page.locator('#diagnostics-panel > summary').click();
  await page.locator('#copy-diagnostics').focus();
  await page.keyboard.press('Tab');
  await expectDiagnosticsTab(page, 'overview');

  for (const name of ['mic', 'audio', 'timing', 'robot', 'raw', 'overview']) {
    await page.keyboard.press('ArrowRight');
    await expectDiagnosticsTab(page, name);
  }
  for (const [key, name] of [
    ['ArrowLeft', 'raw'], ['ArrowLeft', 'robot'], ['Home', 'overview'], ['End', 'raw'],
  ]) {
    await page.keyboard.press(key);
    await expectDiagnosticsTab(page, name);
  }
  await page.keyboard.press('Control+ArrowLeft');
  await expectDiagnosticsTab(page, 'raw');
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('#copy-diagnostics')).toBeFocused();
  await page.keyboard.press('Tab');
  await expectDiagnosticsTab(page, 'raw');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('tabpanel')).toBeFocused();
  await expect(page.getByRole('tabpanel')).toHaveCSS('outline-style', 'solid');
  await page.keyboard.press('Shift+Tab');
  await expectDiagnosticsTab(page, 'raw');
});

test('Diagnostics tabs: click, locale changes and reopening retain the active panel', async ({ page }) => {
  await openState(page, 'system');
  const summary = page.locator('#diagnostics-panel > summary');
  await summary.click();
  await page.locator('#diagnostics-tab-timing').click();
  await expectDiagnosticsTab(page, 'timing');
  await page.evaluate(() => window.relayI18n.setLocale('en', { persist: false }));
  await expectDiagnosticsTab(page, 'timing');
  await expect(page.getByRole('tabpanel')).toHaveAccessibleName('Timing');
  await summary.click();
  await expect(page.getByRole('tabpanel')).toHaveCount(0);
  await summary.click();
  await page.locator('#copy-diagnostics').focus();
  await page.keyboard.press('Tab');
  await expectDiagnosticsTab(page, 'timing');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('tabpanel')).toBeFocused();
});

function selectListenerSong(page, videoId) {
  return page.evaluate((id) => {
    window.dispatchEvent(new CustomEvent('relay:playback-view', {
      detail: {
        role: 'observer',
        room: { videoId: id },
        timeline: {
          videoId: id, state: 1, duration: 200, serverTime: 20, handoffState: 'idle',
          leaderConnected: true, leaderFresh: true, ageMs: 0,
        },
      },
    }));
  }, videoId);
}

test('listeners can read the current room song lyrics without moving the room controls', async ({ page }) => {
  const song = 'PZGwZwGQTlk';
  const missing = 'RNTq42Tg6Qs';
  let attempts = 0;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/song-lyrics?*', async (route) => {
    const videoId = new URL(route.request().url()).searchParams.get('videoId');
    if (videoId === song && ++attempts === 1) {
      await route.fulfill({ status: 503, headers: { 'Retry-After': '1' } });
      return;
    }
    await route.fulfill({
      json: { videoId, lyrics: videoId === song ? { text: '示意歌詞\n第二行', source: null } : null },
    });
  });
  await openState(page, 'listener');
  await page.evaluate(async () => { await import('/song-lyrics.js'); });

  const lyrics = page.getByRole('button', { name: '歌詞', exact: true });
  const panel = page.locator('#song-lyrics');
  await selectListenerSong(page, song);
  await expect(lyrics).toBeVisible();
  const controls = page.locator('.live-actions');
  const before = await controls.boundingBox();
  await lyrics.click();
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('示意歌詞');
  expect(attempts).toBe(2);
  await expect(page.locator('#start-publisher')).toHaveText('接手 Mic');
  expect(await controls.boundingBox()).toEqual(before);

  // A local file waiting in standby still shows the room's YouTube song.
  await page.locator('#local-file-panel').evaluate((element) => { element.hidden = false; });
  await expect(lyrics).toBeVisible();
  await page.locator('.song-stage').evaluate((element) => { element.dataset.localFile = 'on'; });
  await expect(panel).toBeHidden();
  await expect(panel).not.toContainText('示意歌詞');
  await page.locator('.song-stage').evaluate((element) => { element.dataset.localFile = 'off'; });
  await expect(lyrics).toBeVisible();

  await selectListenerSong(page, missing);
  await expect(lyrics).toBeHidden();
  await expect(panel).toBeHidden();
  await expect(panel).not.toContainText('示意歌詞');
});

test('late results cannot replace lyrics after a quick A–B–A song change', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openState(page, 'listener');
  await page.evaluate(async () => {
    // Deliver old responses even after cancellation to exercise the request identity guard.
    window.lyricsRequests = [];
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, options) => {
      const url = new URL(input, location.href);
      if (url.pathname !== '/api/song-lyrics') return originalFetch(input, options);
      const videoId = url.searchParams.get('videoId');
      return new Promise((resolve) => window.lyricsRequests.push((text) =>
        resolve(Response.json({ videoId, lyrics: { text, source: null } }))));
    };
    await import('/song-lyrics.js');
  });

  const song = 'PZGwZwGQTlk';
  await selectListenerSong(page, song);
  await selectListenerSong(page, 'RNTq42Tg6Qs');
  await selectListenerSong(page, song);
  await page.evaluate(() => window.lyricsRequests[2]('最新歌詞'));
  const lyrics = page.getByRole('button', { name: '歌詞', exact: true });
  await lyrics.click();
  const panel = page.locator('#song-lyrics');
  await expect(panel).toContainText('最新歌詞');

  await page.evaluate(async () => {
    window.lyricsRequests[1]('另一首');
    window.lyricsRequests[0]('舊歌詞');
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await expect(panel).toHaveText('最新歌詞');
});
