import assert from 'node:assert/strict';
import test from 'node:test';

const modelUrl = new URL('../public/take-history-model.js', import.meta.url);

function historyItem(overrides: Record<string, unknown> = {}) {
  return {
    takeId: '11111111-1111-4111-8111-111111111111',
    endedAtMs: 2_000,
    songVideoId: 'video-a',
    artifact: { url: '/takes/one.wav', durationMs: 1_000 },
    qualityVerdict: 'clean',
    recovered: false,
    ...overrides,
  };
}

test('Take history accepts only the deliberate product shape', async () => {
  const { validHistoryEntry } = await import(modelUrl.href);

  assert.equal(validHistoryEntry(historyItem()), true);
  assert.equal(validHistoryEntry({
    takeId: '11111111-1111-4111-8111-111111111111',
    endedAtMs: 2_000,
    startedByParticipantId: 'participant-a',
    stoppedByParticipantId: 'participant-b',
    stopReason: 'user',
    song: { videoId: 'video-a' },
    artifact: { url: '/takes/one.wav', durationMs: 1_000 },
    quality: { verdict: 'clean', evidence: {} },
    recovered: false,
  }), false, 'durable TakeLibraryEntry must not become the browser protocol by accident');
});

test('a ready lifecycle Take overlays lossy recovery without leaking the full TakeRecord', async () => {
  const { historyFromStatus } = await import(modelUrl.href);
  const takeId = '22222222-2222-4222-8222-222222222222';
  const recovered = historyItem({
    takeId,
    songVideoId: null,
    qualityVerdict: null,
    recovered: true,
  });

  const history = historyFromStatus({
    lifecycle: 'ready',
    history: [recovered],
    take: {
      takeId,
      endedAtMs: 3_000,
      startedByParticipantId: 'participant-a',
      stoppedByParticipantId: 'participant-a',
      stopReason: 'user',
      song: { videoId: 'video-b' },
      artifact: { url: `/takes/${takeId}.wav`, durationMs: 1_500 },
      quality: { verdict: 'review', evidence: { internal: true } },
    },
  }, []);

  assert.deepEqual(history, [{
    takeId,
    endedAtMs: 3_000,
    songVideoId: 'video-b',
    artifact: { url: `/takes/${takeId}.wav`, durationMs: 1_500 },
    qualityVerdict: 'review',
    recovered: false,
  }]);
  assert.equal('startedByParticipantId' in history[0], false);
  assert.equal('quality' in history[0], false);
});

test('Take history groups attempts by song while keeping voice and recovered recordings distinct', async () => {
  const { groupHistory } = await import(modelUrl.href);
  const groups = groupHistory([
    historyItem({ takeId: 'song-a-1', songVideoId: 'video-a' }),
    historyItem({ takeId: 'song-a-2', songVideoId: 'video-a', endedAtMs: 1_900 }),
    historyItem({ takeId: 'voice-1', songVideoId: null }),
    historyItem({ takeId: 'legacy-1', songVideoId: null, recovered: true }),
  ]);

  assert.equal(groups.length, 3);
  assert.deepEqual(groups.map((group: { key: string }) => group.key), [
    'song:video-a',
    'voice',
    'recovered',
  ]);
  assert.equal(groups[0].entries.length, 2);
  assert.equal(groups[1].entries.length, 1);
  assert.equal(groups[2].entries.length, 1);
});

test('Take history ignores malformed status entries and preserves the last valid snapshot', async () => {
  const { historyFromStatus } = await import(modelUrl.href);
  const previous = [historyItem({ takeId: 'previous' })];

  assert.deepEqual(historyFromStatus({ lifecycle: 'idle' }, previous), previous);
  assert.deepEqual(historyFromStatus({
    lifecycle: 'idle',
    history: [{ takeId: 'broken', artifact: null }],
  }, previous), []);
});
