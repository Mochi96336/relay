import { expect, test } from '@playwright/test';

const BASE = process.env.RELAY_INTERACTION_URL ?? 'http://127.0.0.1:4173/';
test.use({ viewport: { width: 390, height: 844 } });

async function openFollowerFixture(page, { blocked = false } = {}) {
  await page.goto(new URL('__live-visual.html', BASE).href);
  await expect.poll(() => page.evaluate(() => window.__relayVisualReady === true)).toBe(true);
  await page.evaluate(async (blocked) => {
    window.__followerCalls = [];
    window.YT = {
      Player: class {
        constructor(_element, config) {
          this.state = 5;
          this.position = 80;
          this.rate = 1;
          this.config = config;
          window.__localFollower = this;
          queueMicrotask(() => config.events.onReady());
        }
        getCurrentTime() { return this.position; }
        getPlaybackRate() { return this.rate; }
        getPlayerState() { return this.state; }
        cueVideoById({ videoId, startSeconds }) {
          window.__followerCalls.push(['cue', videoId, startSeconds]);
          this.position = startSeconds;
        }
        playVideo() {
          window.__followerCalls.push(['play']);
          if (blocked) this.config.events.onAutoplayBlocked();
          else { this.state = 1; this.config.events.onStateChange({ data: 1 }); }
        }
        pauseVideo() { window.__followerCalls.push(['pause']); this.state = 2; }
        seekTo(position) { window.__followerCalls.push(['seek', position]); this.position = position; }
        setPlaybackRate(rate) { window.__followerCalls.push(['rate', rate]); this.rate = rate; }
        destroy() { window.__followerCalls.push(['destroy']); }
      },
    };
    await import('/choir-follower.js');
    window.__emitFollowerRoom = (options = {}) => {
      window.dispatchEvent(new CustomEvent('relay:playback-view', {
        detail: {
          role: options.role ?? 'observer',
          roomReceivedAtMs: performance.now() - (options.ageMs ?? 0),
          room: options.role === 'holder' ? null : {
            connected: true, videoId: 'abcdefghijk', revision: 5,
            state: 1, serverTime: 80, duration: 220, playbackRate: 1, handoffState: 'idle',
            ...options.room,
          },
        },
      }));
    };
    window.__emitFollowerRoom();
  }, blocked);
}

test('B keeps ordinary Song layout and follows automatically after consent', async ({ page }) => {
  await openFollowerFixture(page);
  await expect(page.locator('#choir-follower-player')).toBeHidden();
  await expect(page.locator('#song-observer')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('relay-choir-guest-state', {
    detail: { enabled: true },
  })));
  await expect(page.locator('#choir-follower-player')).toBeVisible();
  await expect(page.locator('#song-observer')).toBeHidden();
  await expect(page.locator('.youtube-player-shell')).toBeVisible();
  await expect(page.locator('#youtube-player')).toBeHidden();
  await expect(page.locator('#choir-follower-position')).toBeVisible();
  await expect(page.locator('#choir-follower-position')).toContainText(' / 3:40');
  await expect(page.locator('#choir-follower-start')).toHaveCount(0);
  await expect(page.locator('#choir-follower-panel')).toHaveCount(0);
  await expect.poll(async () => (await page.evaluate(() => window.__followerCalls))
    .some(x => x[0] === 'cue')).toBe(true);
  await expect.poll(async () => (await page.evaluate(() => window.__followerCalls))
    .some(x => x[0] === 'play')).toBe(true);
  await expect.poll(() => page.evaluate(() =>
    document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.evaluate(() => window.__emitFollowerRoom({ ageMs: 2000 }));
  await expect.poll(async () => (await page.evaluate(() => window.__followerCalls))
    .some(x => x[0] === 'pause')).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('relay-choir-guest-state', {
    detail: { enabled: false },
  })));
  await expect(page.locator('#choir-follower-player')).toBeHidden();
  await expect(page.locator('#song-observer')).toBeVisible();
  expect((await page.evaluate(() => window.__followerCalls)).some(x => x[0] === 'destroy')).toBe(true);
});

test('manual Play hint appears only when browser actually blocks local autoplay', async ({ page }) => {
  await openFollowerFixture(page, { blocked: true });
  await expect(page.locator('#choir-follower-status')).toBeHidden();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('relay-choir-guest-state', {
    detail: { enabled: true },
  })));
  await expect.poll(async () => (await page.evaluate(() => window.__followerCalls))
    .some(x => x[0] === 'play')).toBe(true);
  await expect(page.locator('#choir-follower-status')).toContainText('播放');
  await page.evaluate(() => window.__emitFollowerRoom({ role: 'holder' }));
  await expect(page.locator('#choir-follower-player')).toBeHidden();
  expect((await page.evaluate(() => window.__followerCalls)).some(x => x[0] === 'destroy')).toBe(true);
});
