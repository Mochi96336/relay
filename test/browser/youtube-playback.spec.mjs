import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { test } from '@playwright/test';
import { launchChromium } from './support/chromium.mjs';

// External-media proof is opt-in: normal CI stays deterministic and offline.
// RELAY_REAL_YOUTUBE=1 RELAY_BROWSER_EXECUTABLE=/usr/bin/chromium npx playwright test test/browser/youtube-playback.spec.mjs --workers=1
const enabled = process.env.RELAY_REAL_YOUTUBE === '1';
const SHORT_VIDEO = process.env.RELAY_YOUTUBE_SHORT_VIDEO_ID ?? 'BsIRoA99bBY';
const VIDEO = 'M7lc1UVf-VE'; // YouTube's IFrame API sample, also used in #642's measurement.

async function startYouTubeHarness() {
  const adapter = await readFile(new URL('../../public/youtube-playback-target.js', import.meta.url));
  const server = http.createServer((req, res) => {
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (req.url?.includes('autoplay-proof')) res.setHeader('Permissions-Policy', 'autoplay=()');
    if (req.url === '/youtube-playback-target.js') {
      res.setHeader('Content-Type', 'text/javascript'); res.end(adapter); return;
    }
    if (req.url === '/room-song-seek-policy.js' || req.url === '/room-song-command-convergence.js') {
      res.setHeader('Content-Type', 'text/javascript');
      const name = req.url.slice(1);
      readFile(new URL(`../../public/${name}`, import.meta.url)).then(body => res.end(body));
      return;
    }
    if (req.url === '/shared/room-song-command-convergence.js') {
      res.setHeader('Content-Type', 'text/javascript');
      readFile(new URL('../../shared/room-song-command-convergence.js', import.meta.url)).then(body => res.end(body));
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><html><body><div id="player"></div><script type="module">
      import { YouTubePlaybackTarget } from '/youtube-playback-target.js';
      let target;
      window.youtubeErrors = [];
      window.autoplayBlocked = 0;
      window.startTarget = (desired, options) => {
        target?.retire();
        window.player.mute();
        target = new YouTubePlaybackTarget(window.player, desired, options);
        target.observe();
      };
      window.readPlayer = () => ({ videoId: window.player.getVideoData()?.video_id,
        state: window.player.getPlayerState(), position: window.player.getCurrentTime(), duration: window.player.getDuration(),
        buffered: window.player.getVideoLoadedFraction(), muted: window.player.isMuted() });
      window.onYouTubeIframeAPIReady = () => {
        window.player = new YT.Player('player', { width: 640, height: 360,
          videoId: '${VIDEO}', playerVars: { playsinline: 1, hl: 'en', origin: location.origin },
          events: {
            onReady() {
              window.playerReady = true;
              if (new URLSearchParams(location.search).has('autoplay-proof')) {
                target = new YouTubePlaybackTarget(window.player, { videoId: '${VIDEO}', state: 1, positionSeconds: 0, playbackRate: 1 }, { mode: 'load' });
                target.observe();
              }
            },
            onStateChange() { target?.observe(); },
            onPlaybackRateChange() { target?.observe(); },
            onAutoplayBlocked() { window.autoplayBlocked++; document.body.dataset.autoplayBlocked = 'true'; },
            onError(event) { window.youtubeErrors.push(event.data); },
          },
        });
      };
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api'; document.head.append(script);
      setInterval(() => target?.observe(), 100);
    </script></body></html>`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return server;
}

async function closeHarness(server, browser) {
  try { await browser?.close(); }
  finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

test('real YouTube: dormant controllers, muted preparation and reused play/pause converge', async ({}, testInfo) => {
  test.skip(!enabled, 'Set RELAY_REAL_YOUTUBE=1 to exercise the external YouTube iframe.');
  test.setTimeout(120_000);
  const server = await startYouTubeHarness();
  let browser;
  const observations = [];
  try {
    browser = await launchChromium({ args: ['--no-sandbox', '--autoplay-policy=document-user-activation-required'] });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => window.playerReady, null, { timeout: 30_000 });
    const apply = async (label, state, positionSeconds, mode, videoId = VIDEO) => {
      await page.evaluate(({ videoId, state, positionSeconds, mode }) => window.startTarget(
        { videoId, state, positionSeconds, playbackRate: 1 }, { mode, seek: 'if-drifted' }),
      { videoId, state, positionSeconds, mode });
      const snapshot = await page.waitForFunction(({ state, videoId, positionSeconds }) => {
        if (window.youtubeErrors.length > 0) return true;
        const observed = window.readPlayer();
        return observed.state === state && observed.videoId === videoId && observed.muted === true
          && (state === 5 || Math.abs(observed.position - positionSeconds) < 1.5 && observed.buffered > 0)
          ? observed : false;
      }, { state, videoId, positionSeconds }, { timeout: 20_000 });
      const errors = await page.evaluate(() => window.youtubeErrors);
      assert.deepEqual(errors, [], `${label}: real iframe error`);
      const observation = await snapshot.jsonValue();
      await snapshot.dispose();
      assert.equal(observation.muted, true);
      if (state !== 5) {
        assert.ok(observation.buffered > 0);
        assert.ok(Math.abs(observation.position - positionSeconds) < 1.5);
      }
      observations.push({ label, ...observation });
    };
    await apply('ended controller prepares replay', 5, 0, 'cue');
    await apply('paused controller near end needs no decoding', 5, 1343, 'cue');
    await apply('cold muted playback', 1, 40, 'load');
    await apply('reused playing player pauses', 2, 40, 'reuse');
    await apply('reused paused player plays', 1, 40, 'reuse');
    await apply('short ended controller', 5, 0, 'cue', SHORT_VIDEO);
    await page.waitForFunction(() => { const duration = window.player.getDuration(); return duration > 0 && duration <= 5; }, null, { timeout: 20_000 });
    const short = await page.evaluate(() => window.readPlayer());
    observations.push({ label: 'real short-video duration confirmed', ...short });
    assert.ok(short.duration > 0 && short.duration <= 5);

  } finally {
    try {
      await testInfo.attach('real-youtube-observations', {
        body: JSON.stringify(observations, null, 2), contentType: 'application/json',
      });
    } finally { await closeHarness(server, browser); }
  }
});


test('real YouTube: blocked autoplay recovers through the visible native Play button', async ({}, testInfo) => {
  test.skip(!enabled, 'Set RELAY_REAL_YOUTUBE=1 to exercise the external YouTube iframe.');
  test.setTimeout(60_000);
  const server = await startYouTubeHarness();
  let browser;
  try {
    browser = await launchChromium({ args: ['--no-sandbox', '--autoplay-policy=document-user-activation-required'] });
    const page = await browser.newPage();
    // evaluate() grants a CDP user gesture. The page starts its unmuted target
    // itself, before evaluated code can authorize playback.
    await page.goto(`http://127.0.0.1:${server.address().port}/?autoplay-proof=1`, { waitUntil: 'domcontentloaded' });
    console.log('[youtube-proof] waiting for blocked autoplay');
    await page.locator('body[data-autoplay-blocked="true"]').waitFor({ timeout: 20_000 });
    console.log('[youtube-proof] autoplay was blocked');
    await page.frameLocator('iframe#player').getByRole('button', { name: 'Play video', exact: true }).click({ timeout: 10_000 });
    console.log('[youtube-proof] native Play clicked');
    await page.waitForFunction(() => window.player.getPlayerState() === 1 && window.player.getVideoLoadedFraction() > 0, null, { timeout: 20_000 });
    console.log('[youtube-proof] native playback recovered');
    const observed = await page.evaluate(() => ({ ...window.readPlayer(), blocked: window.autoplayBlocked > 0 }));
    assert.equal(observed.blocked, true);
    assert.equal(observed.state, 1);
    assert.equal(observed.muted, false);
    await testInfo.attach('autoplay-recovery', { body: JSON.stringify(observed, null, 2), contentType: 'application/json' });
  } finally { await closeHarness(server, browser); }
});
