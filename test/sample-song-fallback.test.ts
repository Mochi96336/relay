import assert from 'node:assert/strict';
import test from 'node:test';
import { FallbackTargetJournal, SampleSongFallback, type SongSampleAnchor } from '../src/sample-song-fallback.js';
import { loadRelayConfig } from '../src/config.js';
const base: SongSampleAnchor = { videoId: 'abcdefghijk', generation: 1, sampleRate: 48000,
  sampleIndex: 0, mediaSeconds: 10, playbackRate: 1, state: 1, uncertaintyMs: 40 };
function feed(f: SampleSongFallback, side: 'mic' | 'backing', offset: number, delay = 0, rate = 1) {
  for (let i = 0; i < 3; i++) f.observe(side, { ...base, playbackRate: rate,
    sampleIndex: (i * .25 + offset) * 48000, mediaSeconds: 10 + i * .25 * rate }, 1000 + i * 250 + delay);
}
const map = (_: string, a: SongSampleAnchor) => a.sampleIndex;
test('pairs content independently of report arrival delay, including negative advances', () => {
  const f = new SampleSongFallback(); feed(f, 'mic', .1, 300); feed(f, 'backing', .5);
  assert.ok(Math.abs(f.estimate(1800, base.videoId, map, 48000)! + 400) < .001);
  const evidence = f.diagnostics(1800);
  assert.equal(evidence.mic?.sampleIndex, .6 * 48000);
  assert.equal(evidence.backing?.sampleIndex, 48000);
  assert.equal(evidence.mic?.ageMs, 0);
  assert.equal(evidence.backing?.ageMs, 300);
  assert.ok(Math.abs(Number(evidence.calculation?.sampleDifferenceMs) + 400) < .001);
  assert.equal(evidence.calculation?.songDifferenceMs, 0);
  f.estimate(2600, base.videoId, map, 48000);
  assert.equal(f.diagnostics(2600).calculation, null, 'expired candidate cannot retain a valid calculation');
});
test('playback rate is used once when comparing different song positions', () => {
  const f = new SampleSongFallback(); feed(f, 'mic', .1, 0, 2); feed(f, 'backing', .5, 0, 2);
  f.observe('mic', { ...base, playbackRate: 2, sampleIndex: .85 * 48000, mediaSeconds: 11.5 }, 1750);
  assert.ok(Math.abs(f.estimate(1750, base.videoId, map, 48000)! + 400) < .001);
});

test('sample/song anchors cannot observe speaker-to-microphone latency', () => {
  const f = new SampleSongFallback();
  // Both players are observed at the same wall instant. Capture timestamps
  // contain 20 ms Mic versus 30 ms backing placement delay, while the Robot
  // player is 200 ms ahead. These facts do not encode either output path.
  for (let i = 0; i < 3; i++) {
    const wall = 1 + i * .25;
    f.observe('mic', { ...base, sampleIndex: (wall + .02) * 48000,
      mediaSeconds: wall }, 1000 + i * 250);
    f.observe('backing', { ...base, sampleIndex: (wall + .03) * 48000,
      mediaSeconds: wall + .2 }, 1000 + i * 250);
  }
  const candidate = f.estimate(1500, base.videoId, map, 48000)!;
  assert.ok(Math.abs(candidate - 190) < .001);
  // A singer hears the phone's output, not its IFrame position. A 120 ms
  // phone output path versus 20 ms Robot output adds 100 ms to the actual
  // acoustic alignment, with exactly the same sample/song reports above.
  const acousticAdvance = 20 - 30 + 200 + 120 - 20;
  assert.equal(acousticAdvance, 290);
  assert.ok(Math.abs(acousticAdvance - candidate - 100) < .001);
});
test('stale, unavailable capture coordinates and different songs cannot drive fallback', () => {
  const f = new SampleSongFallback(); feed(f, 'mic', .1); feed(f, 'backing', .5);
  assert.equal(f.estimate(2501, base.videoId, map, 48000), null);
  assert.equal(f.rejection, 'mic-stale');
  assert.equal(f.estimate(1500, '01234567890', map, 48000), null);
  assert.equal(f.rejection, 'other-song');
  assert.equal(f.estimate(1500, base.videoId, () => null, 48000), null);
  assert.equal(f.rejection, 'unmapped');
  assert.notEqual(f.estimate(1500, base.videoId, map, 48000), null);
  assert.equal(f.rejection, null);
});
test('a missing or unsettled side names itself as the reason', () => {
  const f = new SampleSongFallback();
  f.estimate(1000, base.videoId, map, 48000);
  assert.equal(f.rejection, 'no-mic-anchor');
  f.observe('mic', base, 1000);
  f.estimate(1000, base.videoId, map, 48000);
  assert.equal(f.rejection, 'no-backing-anchor');
  feed(f, 'backing', .5);
  f.estimate(1500, base.videoId, map, 48000);
  assert.equal(f.rejection, 'mic-unsettled');
  feed(f, 'mic', .1, 0, 2);
  f.estimate(1500, base.videoId, map, 48000);
  assert.equal(f.rejection, 'rate-mismatch');
});
test('the fallback target journal logs source changes at once and movement at most once a second', () => {
  const j = new FallbackTargetJournal();
  const song = (targetMs: number) => ({ source: 'sample-song' as const, reason: null, targetMs });
  assert.equal(j.note(song(-600), 0), 'start');
  assert.equal(j.note(song(-610), 2000), null, 'noise below the move threshold');
  assert.equal(j.note(song(-650), 500), null, 'a move within a second of the last line waits');
  assert.equal(j.note(song(-650), 1000), 'move');
  assert.equal(j.note({ source: 'held', reason: 'mic-stale', targetMs: -650 }, 1001), 'source');
  assert.equal(j.note({ source: 'held', reason: 'mic-unsettled', targetMs: -650 }, 1002), 'source');
  assert.equal(j.note(song(-650), 1003), 'source');
  j.reset();
  assert.equal(j.note(song(-650), 1004), 'start');
});
test('seek, capture restart, stopped clock and pause require fresh agreement', () => {
  for (const patch of [{ mediaSeconds: 100 }, { generation: 2 }, { mediaSeconds: 10.5, sampleIndex: 48000 }, { state: 2 }]) {
    const f = new SampleSongFallback(); feed(f, 'mic', .1); feed(f, 'backing', .5);
    f.observe('mic', { ...base, sampleIndex: .85 * 48000, mediaSeconds: 10.75, ...patch }, 1750);
    assert.equal(f.estimate(1750, base.videoId, map, 48000), null);
  }
});
test('invalid uncertainty and nonfinite input fail closed', () => {
  const f = new SampleSongFallback();
  assert.equal(f.observe('mic', { ...base, uncertaintyMs: 1000 }, 1000), false);
  assert.equal(f.observe('mic', { ...base, sampleIndex: NaN }, 1000), false);
});
test('the retired fallback mode setting is ignored, whatever a host still sets', () => {
  for (const mode of ['rtt', 'shadow', 'sample-song', 'typo']) {
    assert.equal('sampleSongFallback' in loadRelayConfig({ RELAY_SAMPLE_SONG_FALLBACK: mode }), false);
  }
});

test('sample coordinates follow capture placement, resampling and generation fences', async () => {
  const { AudioSession } = await import('../src/audio-session.js');
  const s = new AudioSession({ sampleRate: 48000, frameMs: 20, prebufferMs: 400,
    backingGain: .65, retentionMs: 3000 });
  s.start(0);
  const result = s.ingestMic({ generation: 1, firstSampleIndex: 0, pcm: Buffer.alloc(960 * 2) }, 48000, 1000);
  assert.equal(s.sampleSongPosition('mic', 1, 0, 48000), result.start);
  assert.equal(s.sampleSongPosition('mic', 2, 0, 48000), null);
  assert.equal(s.sampleSongPosition('mic', 1, 961, 48000), null);
  assert.equal(s.sampleSongPosition('mic', 1, 0, 44100), null);
  s.ingestMic({ generation: 2, firstSampleIndex: 0, pcm: Buffer.alloc(320 * 2) }, 16000, 2000);
  const end = s.sampleSongPosition('mic', 2, 320, 16000)!;
  assert.equal(end - s.sampleSongPosition('mic', 2, 160, 16000)!, 480);
  assert.equal(s.sampleSongPosition('mic', 1, 0, 48000), null);
  s.resetEpoch(3000);
  assert.equal(s.sampleSongPosition('mic', 2, 160, 16000), null);
});
