import assert from 'node:assert/strict';
import test from 'node:test';

test('Listen requests recovery for WebKit interrupted audio without treating running as resumable', async () => {
  const { shouldRequestAudioResume } = await import(
    new URL('../public/audio-context-recovery.js', import.meta.url).href
  );

  assert.equal(shouldRequestAudioResume('suspended'), true);
  assert.equal(shouldRequestAudioResume('interrupted'), true);
  assert.equal(shouldRequestAudioResume('running'), false);
  assert.equal(shouldRequestAudioResume('closed'), false);
});

test('brief playback interruption resumes in place when no monitor audio was dropped', async () => {
  const { createAudioInterruptionTracker } = await import(
    new URL('../public/audio-context-recovery.js', import.meta.url).href
  );
  let now = 1_000;
  const tracker = createAudioInterruptionTracker({ staleAfterMs: 250, now: () => now });

  tracker.begin();
  now += 100;
  assert.deepEqual(tracker.finish(), {
    interrupted: true,
    durationMs: 100,
    requiresLiveEdge: false,
  });
});

test('dropped monitor audio makes even a short interruption rejoin the live edge', async () => {
  const { createAudioInterruptionTracker } = await import(
    new URL('../public/audio-context-recovery.js', import.meta.url).href
  );
  let now = 2_000;
  const tracker = createAudioInterruptionTracker({ staleAfterMs: 250, now: () => now });

  tracker.begin();
  tracker.noteDroppedPlayback();
  now += 20;
  assert.equal(tracker.finish().requiresLiveEdge, true);
});

test('a long suspended interval rejoins live edge even when page callbacks were frozen', async () => {
  const { createAudioInterruptionTracker } = await import(
    new URL('../public/audio-context-recovery.js', import.meta.url).href
  );
  let now = 3_000;
  const tracker = createAudioInterruptionTracker({ staleAfterMs: 250, now: () => now });

  tracker.begin();
  now += 300;
  assert.equal(tracker.finish().requiresLiveEdge, true);
});
