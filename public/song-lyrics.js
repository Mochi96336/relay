const toggle = document.getElementById('show-song-lyrics');
const panel = document.getElementById('song-lyrics');
const text = document.getElementById('song-lyrics-text');
const source = document.getElementById('song-lyrics-source');
const slot = panel.parentElement;
const heading = toggle.closest('.song-heading-row');
const songStage = heading.closest('.song-stage');
const key = new URLSearchParams(location.search).get('key');

let videoId = null;
let roomVideoId = null;
let request = null;
let retryTimer = null;
let lookupState = 'idle';
let httpStatus = null;
let open = false;

function updateScrollHint() {
  panel.dataset.moreBelow = String(panel.scrollTop + panel.clientHeight < panel.scrollHeight - 1);
}

function render() {
  const style = getComputedStyle(panel);
  const minHeight = 2 * parseFloat(style.lineHeight)
    + parseFloat(style.paddingBlockStart) + parseFloat(style.paddingBlockEnd);
  const triggerSpace = toggle.hidden ? Math.max(0, 44 - heading.offsetHeight) : 0;
  const fits = slot.clientHeight - triggerSpace >= minHeight;
  toggle.hidden = lookupState !== 'available' || !fits;
  panel.hidden = toggle.hidden || !open;
  toggle.setAttribute('aria-expanded', String(!panel.hidden));
  if (!panel.hidden) updateScrollHint();

  const state = lookupState === 'available' && !fits ? 'no-space' : lookupState;
  const previous = window.relayLyricsDiagnostics;
  if (previous?.state === state && previous.videoId === videoId && previous.httpStatus === httpStatus) return;
  const detail = { state, videoId, httpStatus };
  window.relayLyricsDiagnostics = detail;
  window.dispatchEvent(new CustomEvent('relay:lyrics-diagnostics', { detail }));
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
    if (controller !== request) return;
    httpStatus = response.status;
    if (response.status === 409 || response.status >= 500) {
      const retryAfter = response.headers.get('Retry-After');
      if (controller !== request) return;
    httpStatus = response.status;
    if (response.status === 409) retryDelay = 1_000;
      if (retryAfter && /^\d+$/.test(retryAfter)) {
        retryDelay = Math.max(1_000, Math.min(3_600_000, Number(retryAfter) * 1_000));
      }
      throw new Error('Lyrics temporarily unavailable');
    }
    if (!response.ok) {
      lookupState = 'failed';
      render();
      return;
    }
    const result = await response.json();
    if (controller !== request || result.videoId !== videoId) return;
    if (result.lyrics?.text) {
      text.textContent = result.lyrics.text;
      source.textContent = result.lyrics.source ?? '';
      source.hidden = !source.textContent;
    }
    lookupState = result.lyrics?.text ? 'available' : 'missing';
    render();
  } catch {
    if (controller !== request) return;
    lookupState = retriesLeft > 0 ? 'retrying' : 'failed';
    render();
    if (retriesLeft > 0) {
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
  lookupState = next ? 'loading' : 'idle';
  httpStatus = null;
  open = false;
  panel.scrollTop = 0;
  text.textContent = '';
  source.textContent = '';
  render();
  if (videoId) void load(videoId);
}

window.addEventListener('relay:playback-view', ({ detail }) => {
  roomVideoId = detail?.room?.videoId ?? null;
  selectSong();
});
new MutationObserver(selectSong).observe(songStage, { attributeFilter: ['data-local-file'] });
new ResizeObserver(render).observe(slot);

toggle.addEventListener('click', () => {
  open = !open;
  render();
});
panel.addEventListener('scroll', updateScrollHint, { passive: true });
