import { expect, test } from '@playwright/test';

const BASE = process.env.RELAY_INTERACTION_URL ?? 'http://127.0.0.1:4173/';

test.use({ viewport: { width: 390, height: 844 } });

test('B player requires consent, media flag and a local click; never claims room authority', async ({ page }) => {
  await page.goto(new URL('__live-visual.html', BASE).href);
  await page.evaluate(async () => {
    window.__followerCalls = [];
    window.YT = {
      Player: class {
        constructor(_element, config) {
          this.state = 5;
          this.position = 80;
          this.rate = 1;
          queueMicrotask(() => config.events.onReady());
          window.__testFollower = this;
        }
        getCurrentTime() { return this.position; }
        getPlaybackRate() { return this.rate; }
        getPlayerState() { return this.state; }
        cueVideoById({ videoId, startSeconds }) {
          window.__followerCalls.push(['cue', videoId, startSeconds]);
          this.position = startSeconds;
        }
        playVideo() { window.__followerCalls.push(['play']); this.state = 1; }
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
          room: {
            connected: true, videoId: 'abcdefghijk', revision: 5, state: 1,
            serverTime: 80, playbackRate: 1, handoffState: 'idle',
            ...options.room,
          },
        },
      }));
    };
    window.__emitFollowerRoom();
  });
  await expect(page.locator('#choir-follower-panel')).toBeHidden();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('relay-choir-guest-state', {
    detail: { enabled: true },
  })));
  await expect(page.locator('#choir-follower-panel')).toBeVisible();
  expect(await page.evaluate(() => window.__followerCalls)).toEqual([]);
  await page.locator('#choir-follower-start').click();
  await expect.poll(async () => (await page.evaluate(() => window.__followerCalls)).some(c => c[0] === 'cue')).toBe(true);
  await expect.poll(() => page.evaluate(() =>
    document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.evaluate(() => window.__emitFollowerRoom({ ageMs: 2000 }));
  await expect.poll(async () => (await page.evaluate(() => window.__followerCalls)).some(c => c[0] === 'pause')).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('relay-choir-guest-state', {
    detail: { enabled: false },
  })));
  await expect(page.locator('#choir-follower-panel')).toBeHidden();
  expect((await page.evaluate(() => window.__followerCalls)).some(c => c[0] === 'destroy')).toBe(true);
});

test('a B role change to playback holder retires its independent follower', async ({ page }) => {
  await page.goto(new URL('__live-visual.html', BASE).href);
  await page.evaluate(async () => {
    window.YT = { Player: class {
      constructor(_element, events) { queueMicrotask(() => events.events.onReady()); }
      getCurrentTime() { return 80; }
      getPlaybackRate() { return 1; }
      getPlayerState() { return 2; }
      cueVideoById() {}
      destroy() { window.__retiredFollower = true; }
      pauseVideo() {}
      playVideo() {}
    } };
    await import('/choir-follower.js');
    window.dispatchEvent(new CustomEvent('relay-choir-guest-state', { detail: { enabled: true } }));
    window.dispatchEvent(new CustomEvent('relay:playback-view', {
      detail: { role: 'observer', roomReceivedAtMs: performance.now(),
        room: { connected: true, videoId: 'abcdefghijk', revision: 5,
          state: 2, serverTime: 80, playbackRate: 1, handoffState: 'idle' } },
    }));
  });
  await page.locator('#choir-follower-start').click();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('relay:playback-view', {
    detail: { role: 'holder', roomReceivedAtMs: performance.now(), room: null },
  })));
  await expect(page.locator('#choir-follower-panel')).toBeHidden();
  expect(await page.evaluate(() => window.__retiredFollower)).toBe(true);
});
