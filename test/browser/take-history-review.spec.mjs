import { mkdirSync } from 'node:fs';

import { expect, test } from '@playwright/test';

const LIVE_URL = process.env.RELAY_INTERACTION_URL ?? 'http://127.0.0.1:4173/';

mkdirSync('screenshots', { recursive: true });

function endedToday(hour, minute) {
  const value = new Date();
  value.setHours(hour, minute, 0, 0);
  return value.getTime();
}

function historyEntry(takeId, hour, minute, durationMs, overrides = {}) {
  return {
    takeId,
    endedAtMs: endedToday(hour, minute),
    songVideoId: null,
    artifact: {
      url: `/takes/${takeId}.wav`,
      durationMs,
    },
    qualityVerdict: 'clean',
    recovered: false,
    ...overrides,
  };
}

const initialHistory = () => [
  historyEntry('recording-0712', 7, 12, 38_000),
  historyEntry('recording-0705', 7, 5, 42_000),
  historyEntry('recording-0658', 6, 58, 35_000),
];

async function installTakeHistoryHarness(page) {
  await page.addInitScript(() => {
    localStorage.setItem('relay.locale.v1', 'zh-Hant');

    HTMLMediaElement.prototype.play = function play() {
      Object.defineProperty(this, 'paused', {
        configurable: true,
        writable: true,
        value: false,
      });
      this.dispatchEvent(new Event('play'));
      return Promise.resolve();
    };
    HTMLMediaElement.prototype.pause = function pause() {
      const wasPlaying = this.paused === false;
      Object.defineProperty(this, 'paused', {
        configurable: true,
        writable: true,
        value: true,
      });
      if (wasPlaying) this.dispatchEvent(new Event('pause'));
    };
    HTMLMediaElement.prototype.load = function load() {};

    class SilentWebSocket extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;

      constructor(url) {
        super();
        this.url = String(url);
        this.readyState = SilentWebSocket.CONNECTING;
        this.bufferedAmount = 0;
        this.binaryType = 'blob';
        queueMicrotask(() => {
          if (this.readyState !== SilentWebSocket.CONNECTING) return;
          this.readyState = SilentWebSocket.OPEN;
          this.dispatchEvent(new Event('open'));
        });
      }

      send() {}

      close() {
        if (this.readyState === SilentWebSocket.CLOSED) return;
        this.readyState = SilentWebSocket.CLOSED;
        this.dispatchEvent(new CloseEvent('close'));
      }
    }

    window.WebSocket = SilentWebSocket;
    window.relayIdentityReady = Promise.resolve();
  });

  await page.route('https://www.youtube.com/**', (route) => route.abort());
  await page.goto(LIVE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#take-history-panel', { state: 'attached' });
  await expect(page.locator('#last-take-review')).toBeHidden();
}

async function publishHistory(page, history, { lifecycle = 'idle', take = null } = {}) {
  await page.evaluate(({ nextHistory, nextLifecycle, nextTake }) => {
    window.dispatchEvent(new CustomEvent('relay-take-status', {
      detail: {
        type: 'take-status',
        lifecycle: nextLifecycle,
        take: nextTake,
        history: nextHistory,
      },
    }));
  }, {
    nextHistory: history,
    nextLifecycle: lifecycle,
    nextTake: take,
  });
}

async function openHistory(page) {
  const recent = page.locator('#last-take-toggle');
  await expect(recent).toBeVisible();
  await recent.click();
  await expect(page.locator('#take-history-panel')).toHaveAttribute('open', '');
  await expect(page.locator('#close-take-history')).toBeFocused();
}

async function renderedTakeIds(page) {
  return page.locator('.take-history-item').evaluateAll(
    (nodes) => nodes.map((node) => node.dataset.takeId),
  );
}

test('Take History is review-first without changing newest-first selection semantics', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installTakeHistoryHarness(page);

  const history = initialHistory();
  await publishHistory(page, history);
  await openHistory(page);

  const panel = page.locator('#take-history-panel');
  const review = page.locator('#last-take-review');
  const player = page.locator('#recording-player');
  const selected = page.locator('.take-history-selected');

  await expect(page.locator('.take-history-heading-copy strong')).toHaveText('錄音');
  await expect(page.locator('.take-history-heading-copy span')).toHaveText('3 段');
  expect(await renderedTakeIds(page)).toEqual([
    'recording-0712',
    'recording-0705',
    'recording-0658',
  ]);

  const sheetOrder = await page.locator('.take-history-sheet').evaluate((sheet) => (
    [...sheet.children].map((node) => node.className)
  ));
  expect(sheetOrder).toEqual([
    'take-history-panel-heading',
    'take-history-review',
    'take-history-groups',
  ]);

  await expect(page.locator('[data-take-id="recording-0712"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(selected).toContainText('07:12');
  await expect(selected).toContainText('0:38');
  await expect(page.locator('#download-recording')).toHaveText('下載錄音');

  const visibleCopy = await panel.innerText();
  expect(visibleCopy).not.toMatch(/\bTake\b/);
  expect(visibleCopy).not.toContain('Download WAV');
  expect(visibleCopy).not.toContain('下載 WAV');

  await page.locator('[data-take-id="recording-0658"]').click();
  await expect(page.locator('[data-take-id="recording-0658"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(selected).toContainText('06:58');
  await expect(selected).toContainText('0:35');
  await expect(player).toHaveAttribute('src', /recording-0658\.wav/);
  expect(await renderedTakeIds(page)).toEqual([
    'recording-0712',
    'recording-0705',
    'recording-0658',
  ]);

  const newest = historyEntry('recording-0720', 7, 20, 41_000);
  await publishHistory(page, history, {
    lifecycle: 'ready',
    take: {
      takeId: newest.takeId,
      endedAtMs: newest.endedAtMs,
      song: null,
      artifact: newest.artifact,
      quality: { verdict: 'clean' },
    },
  });

  expect(await renderedTakeIds(page)).toEqual([
    'recording-0720',
    'recording-0712',
    'recording-0705',
    'recording-0658',
  ]);
  await expect(page.locator('[data-take-id="recording-0720"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(selected).toContainText('07:20');
  await expect(player).toHaveAttribute('src', /recording-0720\.wav/);
  await expect(page.locator('.take-history-review')).toHaveCount(1);
  await expect(page.locator('#recording-player')).toHaveCount(1);

  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('relay-microphone-local-state', {
      detail: { active: true },
    }));
    return document.querySelector('#recording-player').play();
  });
  await expect(page.locator('#recording-player')).toHaveJSProperty('paused', true);
  await expect(page.locator('.take-history-notice')).toHaveText('請先放 Mic，再播放錄音。');

  await page.evaluate(async () => {
    window.dispatchEvent(new CustomEvent('relay-microphone-local-state', {
      detail: { active: false },
    }));
    await document.querySelector('#recording-player').play();
  });
  await expect(page.locator('#recording-player')).toHaveJSProperty('paused', false);
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('relay-microphone-local-state', {
      detail: { active: true },
    }));
  });
  await expect(page.locator('#recording-player')).toHaveJSProperty('paused', true);
  await expect(page.locator('.take-history-notice')).toHaveText('這支手機拿到 Mic，錄音播放已暫停。');

  const noHorizontalScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(noHorizontalScroll).toBe(true);
  await expect(page.locator('#download-recording')).toBeVisible();
  await page.screenshot({ path: 'screenshots/take-history-review-mobile.png' });

  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('relay-microphone-local-state', {
      detail: { active: false },
    }));
  });
  await page.keyboard.press('Escape');
  await expect(panel).not.toHaveAttribute('open', '');
  await expect(page.locator('#last-take-toggle')).toBeFocused();

  await openHistory(page);
  await panel.evaluate((node) => node.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await expect(panel).not.toHaveAttribute('open', '');
  await expect(page.locator('#last-take-toggle')).toBeFocused();

  await publishHistory(page, []);
  await expect(review).toBeHidden();
  await expect(page.locator('#last-take')).toBeHidden();
});

test('Take History review-first sheet stays readable on desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await installTakeHistoryHarness(page);
  await publishHistory(page, initialHistory());
  await openHistory(page);

  const sheet = page.locator('.take-history-sheet');
  const review = page.locator('.take-history-review');
  const groups = page.locator('.take-history-groups');
  const download = page.locator('#download-recording');

  const [sheetBox, reviewBox, groupsBox] = await Promise.all([
    sheet.boundingBox(),
    review.boundingBox(),
    groups.boundingBox(),
  ]);
  expect(sheetBox).not.toBeNull();
  expect(reviewBox).not.toBeNull();
  expect(groupsBox).not.toBeNull();
  expect(sheetBox.width).toBeLessThanOrEqual(720);
  expect(reviewBox.y).toBeLessThan(groupsBox.y);
  await expect(download).toBeVisible();
  expect((await download.boundingBox()).height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.screenshot({ path: 'screenshots/take-history-review-desktop.png' });
});
