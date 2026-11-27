export type SongLyrics = { text: string; source: string | null };

export class SongLyricsRetryLater extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('Lyrics upstream temporarily unavailable');
  }
}

const origin = 'https://music.youtube.com';
const maxResponseBytes = 512 * 1024;
const maxTextLength = 24_000;
const maxEntries = 128;
const successTtlMs = 60 * 60_000;
const missingTtlMs = 5 * 60_000;

function textFromRuns(runs: unknown): string {
  if (!Array.isArray(runs)) return '';
  return runs.map((run) => typeof run?.text === 'string' ? run.text : '').join('').trim();
}

export function createSongLyricsLookup(fetcher = fetch) {
  const cache = new Map<string, { value: SongLyrics | null; expiresAt: number }>();
  const pending = new Map<string, Promise<SongLyrics | null>>();
  let cooldownUntil = 0;

  async function query(endpoint: 'next' | 'browse', body: object, signal: AbortSignal) {
    const versionDate = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    const response = await fetcher(origin + '/youtubei/v1/' + endpoint + '?alt=json', {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({
        ...body,
        context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.' + versionDate + '.01.00', hl: 'zh_TW', gl: 'TW' } },
      }),
      signal,
    });
    if (!response.ok || !response.body) {
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        const seconds = Number(retryAfter);
        const delay = retryAfter && Number.isFinite(seconds) ? seconds * 1_000
          : retryAfter ? Date.parse(retryAfter) - Date.now() : 0;
        const cooldownMs = Math.max(60_000, Math.min(3_600_000, delay || 0));
        cooldownUntil = Math.max(cooldownUntil, Date.now() + cooldownMs);
      }
      await response.body?.cancel();
      if (response.status === 429) throw new SongLyricsRetryLater(Math.ceil((cooldownUntil - Date.now()) / 1_000));
      throw new Error('Lyrics upstream unavailable');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let json = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxResponseBytes) {
        await reader.cancel();
        throw new Error('Lyrics upstream response too large');
      }
      json += decoder.decode(value, { stream: true });
    }
    return JSON.parse(json + decoder.decode());
  }

  async function fetchLyrics(videoId: string): Promise<SongLyrics | null> {
    const signal = AbortSignal.timeout(5_000);
    const watch = await query('next', { videoId }, signal);
    const tabs = watch?.contents?.singleColumnMusicWatchNextResultsRenderer
      ?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs;
    if (!Array.isArray(tabs)) throw new Error('Unknown lyrics watch response');

    const selectedIds = [];
    let browseId = null;
    for (const { tabRenderer: tab } of tabs) {
      const endpoint = tab?.endpoint?.browseEndpoint;
      if (!tab?.unselectable && endpoint?.browseEndpointContextSupportedConfigs
        ?.browseEndpointContextMusicConfig?.pageType === 'MUSIC_PAGE_TYPE_TRACK_LYRICS') {
        browseId = endpoint.browseId;
      }
      const tracks = tab?.content?.musicQueueRenderer?.content?.playlistPanelRenderer?.contents;
      if (!Array.isArray(tracks)) continue;
      for (const item of tracks) {
        const track = item?.playlistPanelVideoRenderer
          ?? item?.playlistPanelVideoWrapperRenderer?.primaryRenderer?.playlistPanelVideoRenderer;
        if (track?.selected && typeof track.videoId === 'string') selectedIds.push(track.videoId);
      }
    }
    if (!browseId || selectedIds.length !== 1 || selectedIds[0] !== videoId) return null;
    if (typeof browseId !== 'string' || !/^MPLY[A-Za-z0-9_-]{1,150}$/.test(browseId)) {
      throw new Error('Unknown lyrics browse ID');
    }
    const lyrics = await query('browse', { browseId }, signal);
    const sections = lyrics?.contents?.sectionListRenderer?.contents;
    if (!Array.isArray(sections)) throw new Error('Unknown lyrics browse response');
    for (const item of sections) {
      const shelf = item?.musicDescriptionShelfRenderer;
      const text = textFromRuns(shelf?.description?.runs);
      if (!text) continue;
      if (text.length > maxTextLength) throw new Error('Lyrics text too long');
      return { text, source: textFromRuns(shelf?.runs).slice(0, 300) || null };
    }
    return null;
  }

  return function lookup(videoId: string): Promise<SongLyrics | null> {
    const previous = cache.get(videoId);
    if (previous) {
      cache.delete(videoId);
      if (previous.expiresAt > Date.now()) {
        cache.set(videoId, previous);
        return Promise.resolve(previous.value);
      }
    }
    const request = pending.get(videoId);
    if (request) return request;
    const cooldownMs = cooldownUntil - Date.now();
    if (cooldownMs > 0) return Promise.reject(new SongLyricsRetryLater(Math.ceil(cooldownMs / 1_000)));
    if (pending.size >= 2) return Promise.reject(new SongLyricsRetryLater(5));

    const task = fetchLyrics(videoId).then((value) => {
      if (cache.size >= maxEntries) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
      }
      cache.set(videoId, { value, expiresAt: Date.now() + (value ? successTtlMs : missingTtlMs) });
      return value;
    }).finally(() => pending.delete(videoId));
    pending.set(videoId, task);
    return task;
  };
}
