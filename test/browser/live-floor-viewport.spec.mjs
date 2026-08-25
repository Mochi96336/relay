import { expect, test } from '@playwright/test';

const LIVE_URL = process.env.RELAY_INTERACTION_URL ?? 'http://127.0.0.1:4173/';

test.use({ viewport: { width: 390, height: 844 } });

const selectors = {
  header: '.room-header',
  song: '.song-stage',
  performance: '.performance-stage',
  take: '.performance-stage > .take-strip',
  mic: '.performance-stage > .mic-live-control',
  room: '.live-actions',
};

async function geometry(page) {
  return page.evaluate((targets) => Object.fromEntries(
    Object.entries(targets).map(([name, selector]) => {
      const node = document.querySelector(selector);
      if (!node) return [name, null];
      const rect = node.getBoundingClientRect();
      return [name, {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      }];
    }),
  ), selectors);
}

test('floor viewport offset moves controls without reflowing the Live composition', async ({ page }) => {
  await page.goto(new URL('/__live-p0-layout.html?state=singer', LIVE_URL).href, {
    waitUntil: 'domcontentloaded',
  });

  await expect(page.locator(selectors.take)).toBeVisible();
  await expect(page.locator(selectors.mic)).toBeVisible();
  await expect(page.locator(selectors.room)).toBeVisible();

  const before = await geometry(page);
  for (const [name, rect] of Object.entries(before)) {
    expect(rect, `${name} geometry should exist`).not.toBeNull();
  }

  await page.locator('.live-shell').evaluate((shell) => {
    shell.style.setProperty('--live-floor-viewport-offset', '64px');
  });
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));

  const after = await geometry(page);
  for (const name of ['header', 'song', 'performance']) {
    expect(Math.abs(after[name].y - before[name].y), `${name} must not move`).toBeLessThan(0.5);
    expect(
      Math.abs(after[name].height - before[name].height),
      `${name} height must not be reflowed`,
    ).toBeLessThan(0.5);
  }

  for (const name of ['take', 'mic', 'room']) {
    expect(
      Math.abs((after[name].y - before[name].y) - 64),
      `${name} should follow the shared viewport offset`,
    ).toBeLessThan(0.5);
  }
});
