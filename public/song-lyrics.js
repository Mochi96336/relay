const toggle = document.getElementById('show-song-lyrics');
const panel = document.getElementById('song-lyrics');
const text = document.getElementById('song-lyrics-text');
const source = document.getElementById('song-lyrics-source');
const stage = panel.parentElement;
const heading = toggle.closest('.song-heading-row');
const songStage = heading.closest('.song-stage');
const controlsAbove = stage.querySelectorAll('.mic-actions, #mic-takeover, #choir-capture-notice');
const controlsBelow = stage.querySelectorAll('.take-strip, #mic-live-control');
const key = new URLSearchParams(location.search).get('key');

let videoId = null;
let roomVideoId = null;
let request = null;
let retryTimer = null;
let hasLyrics = false;
let open = false;

function visibleBounds(elements) {
  return [...elements].filter((element) => element.getClientRects().length > 0)
    .map((element) => element.getBoundingClientRect());
}

function updateScrollHint() {
  panel.dataset.moreBelow = String(panel.scrollTop + panel.clientHeight < panel.scrollHeight - 1);
}

function layout() {
  const above = visibleBounds(controlsAbove);
  const below = visibleBounds(controlsBelow);
  const start = Math.max(...above.map(({ bottom }) => bottom)) + 10;
  const end = Math.min(...below.map(({ top }) => top)) - 10;
  const height = end - start;
  const triggerSpace = toggle.hidden ? Math.max(0, 44 - heading.offsetHeight) : 0;
  const minHeight = 2 * parseFloat(getComputedStyle(panel).lineHeight);
  const fits = above.length > 0 && below.length > 0 && height - triggerSpace >= minHeight;

  toggle.hidden = !hasLyrics || !fits;
  panel.hidden = toggle.hidden || !open;
  toggle.setAttribute('aria-expanded', String(!panel.hidden));
  if (panel.hidden) return;
  panel.style.top = (start - stage.getBoundingClientRect().top) + 'px';
  panel.style.height = height + 'px';
  updateScrollHint();
}

async function load(song, retriesLeft = 2) {
  const controller = new AbortController();
  request = controller;
  const url = new URL('/api/song-lyrics', location.origin);
  url.searchParams.set('videoId', song);
  if (key) url.searchParams.set('key', key);
  const deadline = setTimeout(() => controller.abort(), 10_000);
  let retryDelay = 15_000;
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (response.status === 409 || response.status >= 500) {
      const retryAfter = response.headers.get('Retry-After');
      if (response.status === 409) retryDelay = 1_000;
      if (retryAfter && /^\d+$/.test(retryAfter)) {
        retryDelay = Math.max(1_000, Math.min(3_600_000, Number(retryAfter) * 1_000));
      }
      throw new Error('Lyrics temporarily unavailable');
    }
    if (!response.ok) return;
    const result = await response.json();
    if (controller !== request || result.videoId !== videoId || !result.lyrics?.text) return;
    text.textContent = result.lyrics.text;
    source.textContent = result.lyrics.source ?? '';
    source.hidden = !source.textContent;
    hasLyrics = true;
    layout();
  } catch {
    if (retriesLeft > 0 && controller === request) {
      retryTimer = setTimeout(() => load(song, retriesLeft - 1), retryDelay);
    }
  } finally {
    clearTimeout(deadline);
  }
}

function selectSong() {
  const next = songStage.dataset.localFile !== 'on'
    && typeof roomVideoId === 'string' && /^[A-Za-z0-9_-]{11}$/.test(roomVideoId) ? roomVideoId : null;
  if (next === videoId) return;

  request?.abort();
  request = null;
  clearTimeout(retryTimer);
  videoId = next;
  hasLyrics = false;
  open = false;
  panel.scrollTop = 0;
  text.textContent = '';
  source.textContent = '';
  layout();
  if (videoId) void load(videoId);
}

window.addEventListener('relay:playback-view', ({ detail }) => {
  roomVideoId = detail?.room?.videoId ?? null;
  selectSong();
});
new MutationObserver(selectSong).observe(songStage, { attributeFilter: ['data-local-file'] });
window.addEventListener('resize', layout);
const resize = new ResizeObserver(layout);
for (const element of [stage, ...controlsAbove, ...controlsBelow]) resize.observe(element);

toggle.addEventListener('click', () => {
  open = !open;
  layout();
});
panel.addEventListener('scroll', updateScrollHint, { passive: true });
