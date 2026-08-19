import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { shouldForceMuteListen } from '../public/playback-recovery.js';

const listen = readFileSync(new URL('../public/listen.js', import.meta.url), 'utf8');
const takeHistory = readFileSync(new URL('../public/take-history.js', import.meta.url), 'utf8');
const youtubeSync = readFileSync(new URL('../public/youtube-sync.js', import.meta.url), 'utf8');
const roomSoundUi = readFileSync(new URL('../public/room-sound-ui.js', import.meta.url), 'utf8');
const roomSoundPresentation = readFileSync(new URL('../public/room-sound-presentation.js', import.meta.url), 'utf8');

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
  assert.match(
    listen,
    /return userMuted[\s\S]*\|\| micForcedMuted[\s\S]*\|\| roomMicForcedMuted[\s\S]*\|\| playbackForcedMuted[\s\S]*\|\| takeReviewForcedMuted;/,
  );
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

test('playback forced mute composes with Mic, review, and user mute without owning product copy', () => {
  assert.match(
    listen,
    /if \(micForcedMuted \|\| roomMicForcedMuted \|\| playbackForcedMuted \|\| takeReviewForcedMuted\) return;/,
    'all forced local-audio overlays must make the Listen toggle non-actionable',
  );
  assert.match(
    listen,
    /function restoreAfterMic[\s\S]*if \(playbackForcedMuted\)[\s\S]*reconcile\('song-owned'\)/,
    'ending Mic ownership must not resume Listen while local playback is actually active',
  );
  assert.match(
    listen,
    /function setPlaybackForcedMute[\s\S]*if \(micForcedMuted \|\| roomMicForcedMuted\)[\s\S]*reconcile\('mic-owned'\)/,
    'ending local playback must not resume Listen while this participant owns the Mic in any tab',
  );
  assert.match(
    listen,
    /function setPlaybackForcedMute[\s\S]*if \(takeReviewForcedMuted\)[\s\S]*reconcile\('take-review'\)/,
    'ending local playback must not resume Listen while Take review isolation is active',
  );
  assert.match(
    listen,
    /function setPlaybackForcedMute[\s\S]*if \(userMuted\)[\s\S]*reconcile\('user-muted'\)/,
    'automatic source changes must not overwrite an explicit user mute',
  );

  assert.doesNotMatch(listen, /t\('listen\./,
    'the audio engine must not regain Room sound product-copy ownership');
  assert.match(
    roomSoundUi,
    /import \{ roomSoundPresentation \} from '\.\/room-sound-presentation\.js'/,
    'the DOM adapter must delegate Room sound product copy to the presenter',
  );
  assert.doesNotMatch(
    roomSoundUi,
    /state === '(?:mic-muted|playback-muted|review-muted|muted)'/,
    'the DOM adapter must not duplicate Room sound product-state copy branches',
  );
  assert.match(roomSoundPresentation, /state === 'mic-muted'/);
  assert.match(roomSoundPresentation, /state === 'playback-muted'/);
  assert.match(roomSoundPresentation, /state === 'review-muted'/);
  assert.match(roomSoundPresentation, /state === 'muted'/);
});

test('Take review speaker playback cannot be fed back through the same participant phone Mic', () => {
  assert.match(takeHistory, /let localMicActive = false/,
    'Take history review must keep the explicit local Mic lifecycle fact');
  assert.match(takeHistory, /let roomMicActive = false/,
    'Take history review also needs same-participant room ownership for sibling tabs');
  assert.match(takeHistory, /window\.addEventListener\('relay-microphone-local-state'[\s\S]*localMicActive = event\.detail\?\.active === true/,
    'Take history review must receive local Mic lifecycle through an explicit module boundary');
  assert.match(takeHistory, /window\.addEventListener\('relay-session-status'/,
    'Take history review must receive canonical room Mic ownership for sibling-tab feedback protection');
  assert.match(takeHistory, /ownerId === participantId/,
    'room ownership must be matched to this participant, not to an unrelated owner');
  assert.match(takeHistory, /function phoneOwnsMic\(\)[\s\S]*return localMicActive \|\| roomMicActive/,
    'Take history review must compose local capture and same-participant room ownership');
  assert.doesNotMatch(takeHistory, /relayActiveRole/,
    'Take history review must not recover the retired shared role global');
  assert.match(takeHistory, /function stopReviewForMic\(kind\)[\s\S]*recordingPlayer\.pause\(\)[\s\S]*reviewNoticeKind = kind/,
    'the shared feedback guard must actually stop local speaker playback');
  assert.match(takeHistory, /recordingPlayer\.addEventListener\('play'[\s\S]*phoneOwnsMic\(\)[\s\S]*stopReviewForMic\('release'\)/,
    'starting Take review while this participant owns Mic must invoke the feedback guard immediately');
  assert.match(takeHistory, /window\.addEventListener\('relay-microphone-started'[\s\S]*recordingPlayer\.paused[\s\S]*stopReviewForMic\('paused'\)/,
    'taking Mic while a Take is already playing must invoke the same feedback guard');
});
