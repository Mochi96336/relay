import assert from 'node:assert/strict';
import test from 'node:test';
import { SongLyricsRetryLater, createSongLyricsLookup } from '../src/song-lyrics.js';

const videoId = 'aaaaaaaaaaa';
const otherId = 'bbbbbbbbbbb';

function watchResponse(selectedId: string) {
  const tracks = { contents: [{ playlistPanelVideoRenderer: { videoId: selectedId, selected: true } }] };
  return Response.json({ contents: { singleColumnMusicWatchNextResultsRenderer: {
    tabbedRenderer: { watchNextTabbedResultsRenderer: { tabs: [
      { tabRenderer: { content: { musicQueueRenderer: { content: { playlistPanelRenderer: tracks } } } } },
      { tabRenderer: { endpoint: { browseEndpoint: {
        browseId: 'MPLYt_example',
        browseEndpointContextSupportedConfigs: {
          browseEndpointContextMusicConfig: { pageType: 'MUSIC_PAGE_TYPE_TRACK_LYRICS' },
        },
      } } } },
    ] } },
  } } });
}

test('lyrics keep all text runs and simultaneous callers share a cached lookup', async () => {
  let requests = 0;
  const lookup = createSongLyricsLookup(async (input) => {
    requests++;
    if (String(input).includes('/next?')) return watchResponse(videoId);
    return Response.json({ contents: { sectionListRenderer: { contents: [
      { musicDescriptionShelfRenderer: {
        description: { runs: [{ text: 'First line\n' }, { text: 'Second line' }] },
        runs: [{ text: 'Example source' }],
      } },
    ] } } });
  });
  const first = lookup(videoId);
  assert.equal(first, lookup(videoId));
  const expected = { text: 'First line\nSecond line', source: 'Example source' };
  assert.deepEqual(await first, expected);
  assert.deepEqual(await lookup(videoId), expected);
  assert.equal(requests, 2);
});

test('a version mismatch is cached as missing and temporary failures can retry', async () => {
  let requests = 0;
  const lookup = createSongLyricsLookup(async () => {
    requests++;
    if (requests === 1) return new Response(null, { status: 503 });
    return watchResponse(otherId);
  });
  await assert.rejects(lookup(videoId));
  assert.equal(await lookup(videoId), null);
  assert.equal(await lookup(videoId), null);
  assert.equal(requests, 2);
});

test('upstream rate limiting delays both the original and subsequent lookups', async () => {
  let requests = 0;
  const lookup = createSongLyricsLookup(async () => {
    requests++;
    return new Response(null, { status: 429, headers: { 'Retry-After': '120' } });
  });
  const shouldBackOff = (error: unknown) => error instanceof SongLyricsRetryLater
    && error.retryAfterSeconds > 0 && error.retryAfterSeconds <= 120;
  await assert.rejects(lookup(videoId), shouldBackOff);
  await assert.rejects(lookup(otherId), shouldBackOff);
  assert.equal(requests, 1);
});
