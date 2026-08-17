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
