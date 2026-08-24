import { expect, test } from '@playwright/test';

const LIVE_URL = process.env.RELAY_INTERACTION_URL ?? 'http://127.0.0.1:4173/';
const FIXTURE_URL = new URL('__room-sound-geometry.html', LIVE_URL).toString();

const states = [
  { state: 'audible', phase: 'playing', muted: false, forcedReason: null, volumePercent: 100 },
  { state: 'muted', phase: 'user-muted', muted: true, forcedReason: null, volumePercent: 9 },
  { state: 'mic-muted', phase: 'mic-owned', muted: true, forcedReason: 'mic', volumePercent: 99 },
  { state: 'playback-muted', phase: 'backing', muted: true, forcedReason: 'backing', volumePercent: 10 },
  { state: 'review-muted', phase: 'take-review', muted: true, forcedReason: 'review', volumePercent: 0 },
  { state: 'audible', phase: 'connecting', muted: false, forcedReason: null, volumePercent: 100 },
  { state: 'audible', phase: 'buffering', muted: false, forcedReason: null, volumePercent: 9 },
  { state: 'audible', phase: 'interrupted', muted: false, forcedReason: null, volumePercent: 99 },
  { state: 'audible', phase: 'reconnecting', muted: false, forcedReason: null, volumePercent: 10 },
  { state: 'ready', phase: 'retry', muted: false, forcedReason: null, volumePercent: 9 },
  { state: 'muted', phase: 'start-failed', muted: true, forcedReason: null, volumePercent: 100 },
  { state: 'audible', phase: 'playing', muted: false, forcedReason: null, volumePercent: 100 },
];

const viewports = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1024, height: 768 },
];

async function settle(page) {
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
}

async function geometry(page) {
  return page.evaluate(() => {
    const rect = (selector) => {
      const box = document.querySelector(selector)?.getBoundingClientRect();
      if (!box) return null;
      return {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        right: box.right,
        bottom: box.bottom,
      };
    };
    const style = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const computed = getComputedStyle(node);
      return {
        position: computed.position,
        width: computed.width,
        height: computed.height,
        overflow: computed.overflow,
      };
    };
    const toggle = document.querySelector('#listen-toggle');
    return {
      row: rect('.local-sound-control'),
      toggle: rect('#listen-toggle'),
      gain: rect('#listen-gain'),
      value: rect('#listen-gain-value'),
      label: rect('#local-listen-label'),
      stableNote: rect('#listen-adjust-state'),
      actionNote: rect('#listen-note'),
      labelStyle: style('#local-listen-label'),
      stableNoteStyle: style('#listen-adjust-state'),
      actionNoteStyle: style('#listen-note'),
      valueText: document.querySelector('#listen-gain-value')?.value ?? '',
      iconState: toggle?.dataset.icon ?? '',
      toggleAria: toggle?.getAttribute('aria-label') ?? '',
      toggleDescription: toggle?.getAttribute('aria-describedby') ?? '',
      stableText: document.querySelector('#listen-adjust-state')?.textContent ?? '',
      scrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    };
  });
}

function expectSameBox(actual, expected, name) {
  expect(actual, `${name} must exist`).not.toBeNull();
  expect(expected, `${name} baseline must exist`).not.toBeNull();
  for (const key of ['x', 'y', 'width', 'height', 'right', 'bottom']) {
    expect(Math.abs(actual[key] - expected[key]), `${name}.${key}`).toBeLessThan(1);
  }
}

for (const viewport of viewports) {
  test(`Room sound keeps one fixed rail through state, value, and locale transitions on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(FIXTURE_URL, { waitUntil: 'networkidle' });
    await page.waitForSelector('#listen-toggle .room-sound-icon');
    await settle(page);

    await page.evaluate(() => {
      window.__relayRoomSoundIconNode = document.querySelector('#listen-toggle .room-sound-icon');
    });

    const baseline = await geometry(page);
    expect(baseline.row?.height).toBeGreaterThanOrEqual(43);
    expect(baseline.row?.height).toBeLessThan(45);
    expect(baseline.toggle?.width).toBeGreaterThanOrEqual(43);
    expect(baseline.toggle?.height).toBeGreaterThanOrEqual(43);
    expect(baseline.scrollWidth).toBe(baseline.viewportWidth);

    for (const locale of ['zh-Hant', 'en']) {
      await page.evaluate((nextLocale) => {
        window.relayI18n.setLocale(nextLocale, { persist: false });
      }, locale);
      await settle(page);

      for (const detail of states) {
        await page.evaluate((nextDetail) => {
          window.dispatchEvent(new CustomEvent('relay-listen-state', { detail: nextDetail }));
        }, detail);
        await settle(page);

        const current = await geometry(page);
        expectSameBox(current.row, baseline.row, 'row');
        expectSameBox(current.toggle, baseline.toggle, 'toggle');
        expectSameBox(current.gain, baseline.gain, 'gain');
        expectSameBox(current.value, baseline.value, 'value');
        expect(current.valueText).toBe(`${detail.volumePercent}%`);
        expect(current.scrollWidth).toBe(current.viewportWidth);

        const retry = detail.phase === 'retry' || detail.phase === 'start-failed';
        const expectedIcon = retry
          ? 'retry'
          : detail.muted === true || Boolean(detail.forcedReason)
            ? 'muted'
            : 'audible';
        expect(current.iconState).toBe(expectedIcon);
        if (retry) {
          expect(current.toggleAria.toLowerCase()).toContain(locale === 'zh-Hant' ? '重試' : 'retry');
        }

        const hasStableReason = detail.state !== 'audible' || detail.phase !== 'playing';
        if (hasStableReason) {
          expect(current.toggleDescription).toBe('listen-adjust-state');
          expect(current.stableText.length).toBeGreaterThan(0);
        } else {
          expect(current.toggleDescription).toBe('');
        }

        const sameIcon = await page.evaluate(() => (
          window.__relayRoomSoundIconNode === document.querySelector('#listen-toggle .room-sound-icon')
        ));
        expect(sameIcon).toBe(true);
      }
    }

    const finalGeometry = await geometry(page);
    for (const [name, rect] of [
      ['label', finalGeometry.label],
      ['stable note', finalGeometry.stableNote],
      ['action note', finalGeometry.actionNote],
    ]) {
      expect(rect, `${name} must remain in the accessibility DOM`).not.toBeNull();
      expect(rect.width, `${name} must not consume horizontal layout`).toBeLessThanOrEqual(1);
      expect(rect.height, `${name} must not consume vertical layout`).toBeLessThanOrEqual(1);
    }
    expect(finalGeometry.labelStyle?.position).toBe('absolute');
    expect(finalGeometry.stableNoteStyle?.position).toBe('absolute');
    expect(finalGeometry.actionNoteStyle?.position).toBe('absolute');
  });
}
