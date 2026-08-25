import { expect, test } from '@playwright/test';

const LIVE_URL = process.env.RELAY_INTERACTION_URL ?? 'http://127.0.0.1:4173/';
const OFFSET_PROPERTY = '--live-floor-viewport-offset';

const selectors = {
  header: '.room-header',
  song: '.song-stage',
  performance: '.performance-stage',
  take: '.performance-stage > .take-strip',
  mic: '.performance-stage > .mic-live-control',
  attention: '#system-attention',
  room: '.live-actions',
};

async function ensureAttention(page) {
  await page.evaluate(() => {
    let attention = document.querySelector('#system-attention');
    if (!attention) {
      attention = document.createElement('section');
      attention.id = 'system-attention';
      attention.className = 'attention-region';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'attention-link';
      button.textContent = 'System needs attention';
      attention.append(button);
      document.querySelector('.live-shell')?.append(attention);
    }
    attention.hidden = false;
  });
}

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

async function installFakeViewportController(page, {
  smallViewportHeight,
  visualViewportHeight,
  settleMs = 30,
}) {
  await page.evaluate(async (config) => {
    const { createLiveFloorViewportController } = await import('/live-floor-viewport.js');
    class FakeViewport extends EventTarget {
      constructor(height) {
        super();
        this.height = height;
        this.offsetTop = 0;
        this.scale = 1;
      }
    }

    const viewport = new FakeViewport(config.visualViewportHeight);
    const controller = createLiveFloorViewportController({
      shell: document.querySelector('.live-shell'),
      viewport,
      isMobile: () => true,
      measureSmallViewportHeight: () => config.smallViewportHeight,
      settleMs: config.settleMs,
      observeShell: false,
    });
    controller.start();
    window.__relayFloorViewportTest = { controller, viewport };
  }, { smallViewportHeight, visualViewportHeight, settleMs });
}

async function setFakeViewportHeight(page, height) {
  await page.evaluate((nextHeight) => {
    const state = window.__relayFloorViewportTest;
    state.viewport.height = nextHeight;
    state.viewport.dispatchEvent(new Event('resize'));
  }, height);
}

async function floorOffset(page) {
  return page.locator('.live-shell').evaluate((shell) => (
    getComputedStyle(shell).getPropertyValue('--live-floor-viewport-offset').trim()
  ));
}

test('startup ignores an already-large visual viewport until real growth follows the small viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 932 });
  await page.goto(new URL('/__live-p0-layout.html?state=singer', LIVE_URL).href, {
    waitUntil: 'domcontentloaded',
  });

  // Safari can briefly report a viewport that extends behind browser chrome at
  // page startup. The controller must not treat that initial large value as
  // permission to move the floor under the URL bar.
  await installFakeViewportController(page, {
    smallViewportHeight: 932,
    visualViewportHeight: 996,
  });
  expect(await floorOffset(page)).toBe('0px');
  await page.waitForTimeout(50);
  expect(await floorOffset(page)).toBe('0px');

  // Even a later larger sample is not enough until the controller has observed
  // the safe small viewport in this viewport epoch.
  await setFakeViewportHeight(page, 998);
  await page.waitForTimeout(50);
  expect(await floorOffset(page)).toBe('0px');

  await setFakeViewportHeight(page, 932);
  await page.waitForTimeout(50);
  expect(await floorOffset(page)).toBe('0px');

  // Once the small viewport was actually seen, settled browser-chrome
  // retraction is allowed to move the floor to the newly visible bottom.
  await setFakeViewportHeight(page, 996);
  expect(await floorOffset(page)).toBe('0px');
  await page.waitForTimeout(50);
  expect(await floorOffset(page)).toBe('64px');

  await page.evaluate(() => window.__relayFloorViewportTest.controller.dispose());
});

test('settled viewport motion moves every floor control without reflowing Live', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 932 });
  await page.goto(new URL('/__live-p0-layout.html?state=singer', LIVE_URL).href, {
    waitUntil: 'domcontentloaded',
  });
  await ensureAttention(page);

  for (const name of ['take', 'mic', 'attention', 'room']) {
    await expect(page.locator(selectors[name])).toBeVisible();
  }

  await installFakeViewportController(page, {
    smallViewportHeight: 932,
    visualViewportHeight: 932,
  });
  expect(await floorOffset(page)).toBe('0px');

  const before = await geometry(page);
  for (const [name, rect] of Object.entries(before)) {
    expect(rect, `${name} geometry should exist`).not.toBeNull();
  }

  // A browser-chrome animation is a burst of viewport changes. The floor must
  // not chase every intermediate height; it moves once after the burst settles.
  for (const height of [948, 972, 996]) {
    await setFakeViewportHeight(page, height);
  }
  expect(await floorOffset(page)).toBe('0px');
  await page.waitForTimeout(50);
  expect(await floorOffset(page)).toBe('64px');

  const after = await geometry(page);
  for (const name of ['header', 'song', 'performance']) {
    expect(Math.abs(after[name].y - before[name].y), `${name} must not move`).toBeLessThan(0.5);
    expect(
      Math.abs(after[name].height - before[name].height),
      `${name} height must not be reflowed`,
    ).toBeLessThan(0.5);
  }

  for (const name of ['take', 'mic', 'attention', 'room']) {
    expect(
      Math.abs((after[name].y - before[name].y) - 64),
      `${name} should follow the shared settled viewport offset`,
    ).toBeLessThan(0.5);
  }

  const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  expect(scrollHeight).toBeLessThanOrEqual(997);

  // When browser chrome takes space back, remove the stale downward offset at
  // the first shrinking event so controls cannot remain hidden below the view.
  await setFakeViewportHeight(page, 960);
  expect(await floorOffset(page)).toBe('0px');

  await page.evaluate(() => window.__relayFloorViewportTest.controller.dispose());
});

test('overflowing short Live never translates the floor or grows scroll range', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 667 });
  await page.goto(new URL('/__live-p0-layout.html?state=singer', LIVE_URL).href, {
    waitUntil: 'domcontentloaded',
  });
  await ensureAttention(page);

  // Keep this proof deterministic even if future density work makes the 667px
  // singer state fit: extra content represents localization/accessibility growth.
  await page.evaluate(() => {
    const shell = document.querySelector('.live-shell');
    if (shell.getBoundingClientRect().height <= 668) {
      const stress = document.createElement('div');
      stress.dataset.floorOverflowStress = 'true';
      stress.style.height = '120px';
      document.querySelector('.song-stage')?.append(stress);
    }
  });

  const shellHeight = await page.locator('.live-shell').evaluate((shell) => shell.getBoundingClientRect().height);
  expect(shellHeight).toBeGreaterThan(668);

  await installFakeViewportController(page, {
    smallViewportHeight: 667,
    visualViewportHeight: 667,
  });

  const before = await geometry(page);
  const scrollHeightBefore = await page.evaluate(() => document.documentElement.scrollHeight);
  await setFakeViewportHeight(page, 731);
  await page.waitForTimeout(50);

  expect(await floorOffset(page)).toBe('0px');
  const after = await geometry(page);
  const scrollHeightAfter = await page.evaluate(() => document.documentElement.scrollHeight);

  for (const name of ['take', 'mic', 'attention', 'room']) {
    expect(Math.abs(after[name].y - before[name].y), `${name} must stay in normal flow`).toBeLessThan(0.5);
  }
  expect(scrollHeightAfter).toBe(scrollHeightBefore);

  await page.evaluate(() => window.__relayFloorViewportTest.controller.dispose());
});
