import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { shouldForceMuteListen } from '../public/playback-recovery.js';

const listen = readFileSync(new URL('../public/listen.js', import.meta.url), 'utf8');
const recorder = readFileSync(new URL('../public/recorder.js', import.meta.url), 'utf8');
const youtubeSync = readFileSync(new URL('../public/youtube-sync.js', import.meta.url), 'utf8');

function timeline(overrides: Record<string, unknown> = {}) {
  return {
    playbackLeaderParticipantId: 'participant-self',
    playbackTransportId: 'playback-self',
    playbackGeneration: 1,
    leaderConnected: true,
    leaderFresh: true,
    state: 1,
    ...overrides,
  };
}

test('Listen follows server playback health and activity instead of holder identity alone', () => {
  assert.match(listen, /import \{ shouldForceMuteListen \} from '\.\/playback-recovery\.js'/);
  assert.match(listen, /let playbackForcedMuted = false;/);
  assert.match(listen, /return userMuted \|\| micForcedMuted \|\| playbackForcedMuted;/);
  assert.match(listen, /window\.addEventListener\('relay:playback-view'/);
  assert.match(listen, /setPlaybackForcedMute\(shouldForceMuteListen\(\{/);
  assert.match(listen, /role: event\.detail\?\.role/);
  assert.match(listen, /timeline: event\.detail\?\.timeline/);
  assert.doesNotMatch(listen, /role === 'holder' \|\| role === 'preparing'/,
    'holder identity alone must not close the local monitor transport');
  assert.match(youtubeSync, /new CustomEvent\('relay:playback-view'/,
    'Listen must consume the server playback snapshot rather than infer authority locally');
});

test('healthy active local playback mutes Listen, but pause/end/staleness releases it', () => {
  assert.equal(shouldForceMuteListen({ role: 'holder', timeline: timeline({ state: 1 }) }), true);
  assert.equal(shouldForceMuteListen({ role: 'holder', timeline: timeline({ state: 3 }) }), true);
  assert.equal(shouldForceMuteListen({ role: 'holder', timeline: timeline({ state: 2 }) }), false);
  assert.equal(shouldForceMuteListen({ role: 'holder', timeline: timeline({ state: 0 }) }), false);
  assert.equal(shouldForceMuteListen({ role: 'holder', timeline: timeline({ leaderFresh: false }) }), false);
  assert.equal(shouldForceMuteListen({ role: 'holder', timeline: timeline({ leaderConnected: false }) }), false);
  assert.equal(shouldForceMuteListen({ role: 'observer', timeline: timeline({ state: 1 }) }), false);
});

test('playback forced mute composes with Mic mute and preserves the user preference', () => {
  assert.match(listen, /if \(micForcedMuted \|\| playbackForcedMuted\) return;/,
    'forced source roles must make the local Listen toggle non-actionable');
  assert.match(listen, /if \(playbackForcedMuted\) \{[\s\S]*t\('listen\.songOwned'\)/,
    'ending Mic ownership must not resume Listen while local playback is actually active');
  assert.match(listen, /if \(micForcedMuted\) \{[\s\S]*t\('listen\.micOwned'\)/,
    'ending local playback must not resume Listen while this phone still owns the Mic');
  assert.match(listen, /if \(userMuted\) \{[\s\S]*t\('listen\.adjust\.userMuted'\)/,
    'automatic source changes must not overwrite an explicit user mute');
});

test('Last Take speaker playback cannot be fed back through the same phone Mic', () => {
  assert.match(recorder, /function phoneOwnsMic\(\)[\s\S]*window\.relayActiveRole === 'publisher'/,
    'Take review must use the same local Mic ownership fact as the capture controller');
  assert.match(recorder, /function stopReviewForMic\(copy\)[\s\S]*recordingPlayer\.pause\(\)[\s\S]*reviewNotice = copy/,
    'the shared feedback guard must actually stop local speaker playback');
  assert.match(recorder, /recordingPlayer\.addEventListener\('play'[\s\S]*phoneOwnsMic\(\)[\s\S]*stopReviewForMic\(t\('take\.reviewReleaseMic'\)\)/,
    'starting Take review while publishing Mic must invoke the feedback guard immediately');
  assert.match(recorder, /window\.addEventListener\('relay-microphone-started'[\s\S]*recordingPlayer\.paused[\s\S]*stopReviewForMic\(t\('take\.reviewPausedForMic'\)\)/,
    'taking Mic while a Take is already playing must invoke the same feedback guard');
});
