import { expect, test } from '@playwright/test';

const BASE = process.env.RELAY_INTERACTION_URL ?? 'http://127.0.0.1:4173/';
test.use({ viewport: { width: 390, height: 844 } });

async function openFollowerFixture(page, { blocked = false, unmutePauses = false } = {}) {
  // Deterministic fixture: YouTube is mocked below; external assets must not
  // hold navigation open when the network is slow or unavailable.
  await page.route('**/*', route => new URL(route.request().url()).origin === new URL(BASE).origin
    ? route.continue() : route.abort());
  await page.goto(new URL('__live-visual.html', BASE).href);
  await expect.poll(() => page.evaluate(() => window.__relayVisualReady === true)).toBe(true);
  await page.evaluate(async ({ blocked, unmutePauses }) => {
    window.__followerCalls = [];
    window.__songAnchors = 0;
    window.addEventListener('relay-choir-song-anchor', () => { window.__songAnchors++; });
    window.__choirLocalAudibility = [];
    window.addEventListener('relay-choir-local-playback', event => {
      window.__choirLocalAudibility.push(event.detail?.active);
    });
    window.YT = {
      Player: class {
        constructor(_element, config) {
          this.state = 5;
          this.position = 80;
          this.rate = 1;
          this.muted = false;
          this.config = config;
          window.__localFollower = this;
          window.__followerCalls.push(['create', config.videoId, config.playerVars?.start, config.playerVars?.origin]);
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
        mute() { window.__followerCalls.push(['mute']); this.muted = true; }
        // WebKit pauses a scripted unmute without a fresh tap.
        unMute() {
          window.__followerCalls.push(['unmute']);
          if (unmutePauses) this.state = 2;
          else this.muted = false;
        }
        isMuted() { return this.muted; }
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
  }, { blocked, unmutePauses });
}

test('B keeps ordinary Song layout and follows automatically after consent', async ({ page }) => {
  await openFollowerFixture(page);
  await expect(page.locator('#choir-follower-player')).toBeHidden();
  await expect(page.locator('#song-observer')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('relay-choir-guest-state', {
    detail: { enabled: true },
  })));
  await expect(page.locator('#choir-follower-player')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__choirLocalAudibility.at(-1))).toBe(true);
  await expect(page.locator('#song-observer')).toBeHidden();
  await expect(page.locator('.youtube-player-shell')).toBeVisible();
  await expect(page.locator('#youtube-player')).toBeHidden();
  await expect(page.locator('#choir-follower-position')).toBeVisible();
  await expect(page.locator('#choir-follower-position')).toContainText(' / 3:40');
  await expect(page.locator('#choir-follower-start')).toHaveCount(0);
  await expect(page.locator('#choir-follower-panel')).toHaveCount(0);
  // Created with the room's video, as the main player is (iPhone fails an empty one).
  expect((await page.evaluate(() => window.__followerCalls)).find(x => x[0] === 'create'))
    .toEqual(['create', 'abcdefghijk', 80, new URL(BASE).origin]);
  await expect.poll(async () => (await page.evaluate(() => window.__followerCalls))
    .some(x => x[0] === 'play')).toBe(true);
  // Muted first, which any browser lets a script play, then turned up.
  await expect.poll(async () => (await page.evaluate(() => window.__followerCalls))
    .map(x => x[0]).filter(x => x === 'mute' || x === 'unmute').join()).toBe('mute,unmute');
  await expect.poll(() => page.evaluate(() => window.__localFollower.muted)).toBe(false);
  await expect(page.locator('#choir-follower-status')).toBeHidden();
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
  expect((await page.evaluate(() => window.__choirLocalAudibility)).at(-1)).toBe(false);
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


test('video failure restores Monitor availability without withdrawing consent', async ({ page }) => {
  await openFollowerFixture(page);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('relay-choir-guest-state', {
    detail: { enabled: true },
  })));
  await expect.poll(() => page.evaluate(() => window.__choirLocalAudibility.at(-1))).toBe(true);
  await page.evaluate(() => window.__localFollower.config.events.onError());
  await expect.poll(() => page.evaluate(() => window.__choirLocalAudibility.at(-1))).toBe(false);
  await expect(page.locator('#choir-follower-player')).toBeVisible();
});

test('where a tap is needed for sound (iOS), the song keeps time muted and B is asked to tap', async ({ page }) => {
  await openFollowerFixture(page, { unmutePauses: true });
  // The server keeps the room clock fresh; one snapshot goes stale in ~2 s.
  await page.evaluate(() => { setInterval(() => window.__emitFollowerRoom(), 300); });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('relay-choir-guest-state', {
    detail: { enabled: true },
  })));
  const status = page.locator('#choir-follower-status');
  await expect(status).toHaveText('歌曲正在靜音播放：點一下 YouTube 播放器開啟聲音。');
  // Back to muted playback, so B's YouTube time still aligns B in the room.
  await expect.poll(() => page.evaluate(() => ({
    state: window.__localFollower.state, muted: window.__localFollower.muted,
  }))).toEqual({ state: 1, muted: true });
  const anchors = await page.evaluate(() => window.__songAnchors);
  await expect.poll(() => page.evaluate(() => window.__songAnchors)).toBeGreaterThan(anchors);
  // B taps the player's sound on.
  await page.evaluate(() => { window.__localFollower.muted = false; });
  await expect(status).toBeHidden();
  const calls = (await page.evaluate(() => window.__followerCalls)).map(x => x[0]);
  expect(calls.filter(x => x === 'unmute')).toHaveLength(1);
});
