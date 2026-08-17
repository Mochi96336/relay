import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldRequestAudioResume } from '../public/audio-context-recovery.js';

test('Listen requests recovery for WebKit interrupted audio without treating running as resumable', () => {
  assert.equal(shouldRequestAudioResume('suspended'), true);
  assert.equal(shouldRequestAudioResume('interrupted'), true);
  assert.equal(shouldRequestAudioResume('running'), false);
  assert.equal(shouldRequestAudioResume('closed'), false);
});
