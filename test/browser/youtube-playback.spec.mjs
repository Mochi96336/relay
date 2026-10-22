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
  const server = http.createServer((req, res) => {
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (/^\/(?:shared\/)?[a-zA-Z0-9_-]+\.js$/.test(pathname)) {
      res.setHeader('Content-Type', 'text/javascript');
      const source = pathname.startsWith('/shared/') ? `../../${pathname.slice(1)}` : `../../public${pathname}`;
      readFile(new URL(source, import.meta.url)).then(body => res.end(body)).catch(() => { res.statusCode = 404; res.end(); });
      return;
    }
    if (pathname === '/production') {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<!doctype html><html><body>
        <input id="youtube-url"><button id="load-youtube">Load</button><div id="youtube-player"></div>
        <span id="youtube-state"></span><span id="youtube-timeline"></span><span id="youtube-note"></span>
        <script>
          window.players = []; window.iframes = []; window.readyPlayers = []; window.calls = []; window.events = [];
          window.send = (type, detail) => window.dispatchEvent(new CustomEvent('relay:' + type, { detail }));
          for (const type of ['song-handoff-ready', 'song-handoff-failed', 'room-song-command-intent']) {
            window.addEventListener('relay:' + type, event => window.events.push({ type, ...event.detail }));
          }
          window.readPlayer = () => {
            const p = window.players.at(-1);
            return { videoId: p.getVideoData()?.video_id, state: p.getPlayerState(),
              muted: p.isMuted(), buffered: p.getVideoLoadedFraction() };
          };
          window.onYouTubeIframeAPIReady = async () => {
            const RealPlayer = YT.Player;
            YT.Player = function(element, options) {
              const index = window.players.length;
              const ready = options.events.onReady;
              options.events.onReady = event => {
                window.readyPlayers[index] = true;
                window.iframes[index] = event.target.getIframe();
                for (const name of ['loadVideoById', 'cueVideoById', 'destroy']) {
                  const original = event.target[name].bind(event.target);
                  event.target[name] = (...args) => {
                    window.calls.push({ index, name, muted: event.target.isMuted() });
                    return original(...args);
                  };
                }
                ready(event);
              };
              const p = new RealPlayer(element, options); window.players.push(p); return p;
            };
            await import('/youtube.js'); window.productionReady = true;
          };
        </script><script src="https://www.youtube.com/iframe_api"></script></body></html>`);
      return;
    }
    if (req.url?.includes('autoplay-proof')) res.setHeader('Permissions-Policy', 'autoplay=()');
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

for (const sameVideo of [true, false]) {
  test(`real production owner: ${sameVideo ? 'same' : 'different'}-video Load is isolated from a new CUED iframe`, async ({}, testInfo) => {
    test.skip(!enabled, 'Set RELAY_REAL_YOUTUBE=1 to exercise the external YouTube iframe.');
    test.setTimeout(120_000);
    const server = await startYouTubeHarness();
    let browser;
    try {
      browser = await launchChromium({ args: ['--no-sandbox', '--autoplay-policy=document-user-activation-required'] });
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${server.address().port}/production`);
      await page.waitForFunction(() => window.productionReady, null, { timeout: 30_000 });
      await page.evaluate(({ videoId }) => {
        window.send('playback-view', { role: 'observer' });
        window.send('song-handoff-prepare', { handoffId: 'old-load', videoId,
          serverTime: 0, state: 1, playbackRate: 1 });
      }, { videoId: sameVideo ? VIDEO : SHORT_VIDEO });
      await page.waitForFunction(() => window.calls.some(c => c.name === 'loadVideoById'), null, { timeout: 30_000 });
      await page.evaluate(videoId => window.send('song-handoff-prepare', {
        handoffId: 'new-cue', videoId, serverTime: 0, state: 5, playbackRate: 1,
      }), VIDEO);
      await page.waitForFunction(videoId => {
        if (window.players.length !== 2 || !window.readyPlayers[1]) return false;
        const p = window.readPlayer();
        return p.videoId === videoId && p.state === 5 && p.muted
          && window.events.some(e => e.type === 'song-handoff-ready' && e.handoffId === 'new-cue');
      }, VIDEO, { timeout: 30_000 });
      await page.evaluate(() => window.send('song-handoff-commit', { handoffId: 'new-cue', state: 5, serverTime: 0 }));
      await page.waitForFunction(() => window.readPlayer().state === 5);
      await page.evaluate(() => {
        window.send('playback-view', { role: 'holder' });
        window.send('song-handoff-complete', { handoffId: 'new-cue' });
      });
      // unMute(), like Load, is asynchronous: prove its observed result before
      // checking stability, rather than treating the request as an observation.
      await page.waitForFunction(() => window.readPlayer().state === 5 && !window.readPlayer().muted,
        null, { timeout: 10_000 });
      // Observe a stable interval after completion, including physical audibility.
      await page.evaluate(videoId => new Promise((resolve, reject) => {
        let samples = 0;
        const timer = setInterval(() => {
          const p = window.readPlayer();
          if (p.state !== 5 || p.muted || p.videoId !== videoId) {
            clearInterval(timer); reject(Error(JSON.stringify(p))); return;
          }
          if (++samples === 20) { clearInterval(timer); resolve(); }
        }, 100);
      }), VIDEO);
      assert.equal(await page.locator('iframe#youtube-player').count(), 1);
      const retired = await page.evaluate(() => window.calls.filter(c => c.name === 'destroy').map(c => c.index));
      assert.deepEqual(retired, [0]);
      assert.deepEqual(await page.evaluate(() => window.iframes.map(frame => frame.isConnected)), [false, true]);
      await page.frameLocator('iframe#youtube-player').getByRole('button', { name: /Play video|播放/, exact: false }).click({ timeout: 15_000 });
      await page.waitForFunction(() => {
        const p = window.readPlayer();
        return p.state === 1 && p.buffered > 0 && !p.muted
          && window.events.some(e => e.type === 'room-song-command-intent' && e.action === 'play');
      }, null, { timeout: 20_000 });
      await testInfo.attach('production-iframe-isolation', { body: JSON.stringify(await page.evaluate(() => ({
        calls: window.calls, events: window.events, final: window.readPlayer(),
      })), null, 2), contentType: 'application/json' });
    } finally { await closeHarness(server, browser); }
  });
}
