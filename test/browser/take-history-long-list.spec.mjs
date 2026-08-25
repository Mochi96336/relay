import { expect, test } from '@playwright/test';

const LIVE_URL = process.env.RELAY_INTERACTION_URL ?? 'http://127.0.0.1:4173/';

function historyEntry(index) {
  const endedAt = new Date();
  endedAt.setHours(8, 59 - index, 0, 0);
  const takeId = `recording-${String(index).padStart(2, '0')}`;
  return {
    takeId,
    endedAtMs: endedAt.getTime(),
    songVideoId: null,
    artifact: {
      url: `/takes/${takeId}.wav`,
      durationMs: 30_000 + index * 1_000,
    },
    qualityVerdict: 'clean',
    recovered: false,
  };
}

async function installHarness(page) {
  await page.addInitScript(() => {
    localStorage.setItem('relay.locale.v1', 'zh-Hant');

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
}

async function publishLongHistory(page) {
  const history = Array.from({ length: 18 }, (_, index) => historyEntry(index));
  await page.evaluate((nextHistory) => {
    window.dispatchEvent(new CustomEvent('relay-take-status', {
      detail: {
        type: 'take-status',
        lifecycle: 'idle',
        take: null,
        history: nextHistory,
      },
    }));
  }, history);
  await page.locator('#last-take-toggle').click();
}

async function scrollReviewOutOfView(page) {
  await page.locator('.take-history-sheet').evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });

  const reviewWasAboveViewport = await page.evaluate(() => {
    const reviewRect = document.querySelector('.take-history-review').getBoundingClientRect();
    const headingRect = document.querySelector('.take-history-panel-heading').getBoundingClientRect();
    return reviewRect.bottom <= headingRect.bottom;
  });
  expect(reviewWasAboveViewport).toBe(true);
}

async function expectReviewVisibleInSheet(page) {
  const reviewVisible = await page.evaluate(() => {
    const sheetRect = document.querySelector('.take-history-sheet').getBoundingClientRect();
    const headingRect = document.querySelector('.take-history-panel-heading').getBoundingClientRect();
    const reviewRect = document.querySelector('.take-history-review').getBoundingClientRect();
    return reviewRect.top >= headingRect.bottom - 1
      && reviewRect.bottom <= sheetRect.bottom + 1;
  });
  expect(reviewVisible).toBe(true);
}

test('pointer selection of a deep recording returns review controls without stealing focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installHarness(page);
  await publishLongHistory(page);

  const panel = page.locator('#take-history-panel');
  const review = page.locator('.take-history-review');
  const heading = page.locator('.take-history-panel-heading');
  const target = page.locator('[data-take-id="recording-17"]');

  await expect(panel).toHaveAttribute('open', '');
  await scrollReviewOutOfView(page);

  await target.click();
  await expect(target).toHaveAttribute('aria-pressed', 'true');
  await expect(target).toBeFocused();
  await expect(page.locator('#recording-player')).toHaveAttribute('src', /recording-17\.wav/);
  await expectReviewVisibleInSheet(page);

  await expect(review).toBeVisible();
  await expect(heading).toBeVisible();
});

test('keyboard selection of a deep recording moves focus with the revealed review', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installHarness(page);
  await publishLongHistory(page);

  const target = page.locator('[data-take-id="recording-17"]');
  const player = page.locator('#recording-player');

  await target.focus();
  await scrollReviewOutOfView(page);
  await target.press('Enter');

  await expect(target).toHaveAttribute('aria-pressed', 'true');
  await expect(player).toHaveAttribute('src', /recording-17\.wav/);
  await expect(player).toBeFocused();
  await expectReviewVisibleInSheet(page);

  const activeControlVisible = await page.evaluate(() => {
    const active = document.activeElement;
    const sheetRect = document.querySelector('.take-history-sheet').getBoundingClientRect();
    const headingRect = document.querySelector('.take-history-panel-heading').getBoundingClientRect();
    const activeRect = active?.getBoundingClientRect();
    return active?.id === 'recording-player'
      && activeRect
      && activeRect.top >= headingRect.bottom - 1
      && activeRect.bottom <= sheetRect.bottom + 1;
  });
  expect(activeControlVisible).toBe(true);
});
