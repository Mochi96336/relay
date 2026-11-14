import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FallbackPlacement, FallbackTargetJournal, SampleSongFallback, type SongSampleAnchor,
} from '../src/sample-song-fallback.js';
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
test('an anchor whose audio has not landed is awaited, not counted as a lapse', () => {
  const f = new SampleSongFallback(); feed(f, 'mic', .1); feed(f, 'backing', .5);
  const candidate = f.estimate(1500, base.videoId, map, 48000);
  const calculation = f.diagnostics(1500).calculation;
  assert.notEqual(candidate, null);
  // The Robot bridge sent each song clock just before the PCM it timestamps.
  const backingAhead = (side: string, a: SongSampleAnchor) => side === 'backing' ? 'ahead' as const : a.sampleIndex;
  assert.equal(f.estimate(1501, base.videoId, backingAhead, 48000), null);
  assert.equal(f.rejection, 'awaiting-audio');
  assert.equal(f.diagnostics(1501).calculation, calculation, 'the last calculation still describes the voice');
  // A side that cannot be placed at all outranks one that is merely early.
  assert.equal(f.estimate(1502, base.videoId, (side, a) => side === 'mic' ? null : backingAhead(side, a), 48000), null);
  assert.equal(f.rejection, 'unmapped');
  // Waiting is bounded by staleness: audio that never comes is a lapse.
  assert.equal(f.estimate(2501, base.videoId, backingAhead, 48000), null);
  assert.equal(f.rejection, 'mic-stale');
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
  // A steady song alternating between two values 22 ms apart, as on 2026-11-14.
  for (let atMs = 3_000; atMs < 20_000; atMs += 1_000) {
    assert.equal(j.note(song(atMs % 2_000 === 0 ? -600 : -622), atMs), null, `alternation at ${atMs}`);
  }
  assert.equal(j.note(song(-650), 20_500), 'move', 'a real drift is still logged');
  assert.equal(j.note(song(-690), 21_000), null, 'a move within a second of the last line waits');
  assert.equal(j.note(song(-690), 21_500), 'move');
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
  // Up to a second past the frontier is this capture's audio still on its way.
  assert.equal(s.sampleSongPosition('mic', 1, 961, 48000), 'ahead');
  assert.equal(s.sampleSongPosition('mic', 1, 960 + 48000, 48000), 'ahead');
  assert.equal(s.sampleSongPosition('mic', 1, 960 + 48001, 48000), null);
  assert.equal(s.sampleSongPosition('mic', 2, 961, 48000), null);
  assert.equal(s.sampleSongPosition('mic', 1, 0, 44100), null);
  s.ingestMic({ generation: 1, firstSampleIndex: 960, pcm: Buffer.alloc(960 * 2) }, 48000, 1020);
  assert.equal(typeof s.sampleSongPosition('mic', 1, 961, 48000), 'number', 'it maps once its PCM lands');
  s.ingestMic({ generation: 2, firstSampleIndex: 0, pcm: Buffer.alloc(320 * 2) }, 16000, 2000);
  const end = s.sampleSongPosition('mic', 2, 320, 16000) as number;
  assert.equal(end - (s.sampleSongPosition('mic', 2, 160, 16000) as number), 480);
  assert.equal(s.sampleSongPosition('mic', 1, 0, 48000), null);
  s.resetEpoch(3000);
  assert.equal(s.sampleSongPosition('mic', 2, 160, 16000), null);
});

test('the first candidate for a song is placed at once, and later near ones are walked to', () => {
  const p = new FallbackPlacement(20);
  assert.deepEqual(p.decide(-1200, 0, base.videoId, 0), { kind: 'place', ms: -1200 });
  assert.equal(p.placed, true);
  assert.deepEqual(p.decide(-1190, -1200, base.videoId, 100), { kind: 'walk', ms: -1190 });
  assert.deepEqual(p.decide(-300, -1190, '01234567890', 200), { kind: 'place', ms: -300 }, 'a new song places again');
});
test('a lapse holds the voice where it is, never toward the last estimate', () => {
  const p = new FallbackPlacement(20);
  p.decide(-600, 0, base.videoId, 0);
  assert.deepEqual(p.decide(-620, -604, base.videoId, 100), { kind: 'walk', ms: -620 });
  assert.deepEqual(p.decide(null, -604, base.videoId, 200), { kind: 'hold' });
});
test('a far candidate is placed only after a second of candidates agreeing with it', () => {
  const p = new FallbackPlacement(20);
  p.decide(0, 0, base.videoId, 0);
  // Far all along, but never the same far: each one restarts the count.
  for (const [at, ms] of [[100, 200], [600, -300], [1200, 500], [1700, 200]] as const) {
    assert.deepEqual(p.decide(ms, 0, base.videoId, at), { kind: 'hold' }, `${ms} at ${at}`);
  }
  // The same far, within the walk limit, for a second: placed at the latest.
  assert.deepEqual(p.decide(210, 0, base.videoId, 2200), { kind: 'hold' });
  assert.deepEqual(p.decide(195, 0, base.videoId, 2700), { kind: 'place', ms: 195 });
});
test('a lapse restarts the confirmation of a far candidate', () => {
  const p = new FallbackPlacement(20);
  p.decide(0, 0, base.videoId, 0);
  assert.deepEqual(p.decide(300, 0, base.videoId, 100), { kind: 'hold' });
  assert.deepEqual(p.decide(null, 0, base.videoId, 600), { kind: 'hold' });
  assert.deepEqual(p.decide(300, 0, base.videoId, 1200), { kind: 'hold' }, 'counted from 1200, not 100');
  assert.deepEqual(p.decide(300, 0, base.videoId, 2200), { kind: 'place', ms: 300 });
});
