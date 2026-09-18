import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findUniqueFunctionSource,
  readRepositoryTextFile,
} from './helpers/source-contract.js';

const server = readRepositoryTextFile('src/server.ts');

function body(name: string) {
  return findUniqueFunctionSource(name).declaration;
}

/**
 * Every timing quantity in this system is either wall time or media time, and
 * the two are only the same number at 1x.
 *
 * - Probe path latencies, the mixer read-ahead and capture sample positions are
 *   wall time.
 * - Robot player deltas and seek jumps are media time: the Robot page subtracts
 *   two `currentTime` readings.
 *
 * The playback rate is the only conversion between them, so every place a
 * media quantity reaches wall-time arithmetic has to pass through it. Missing
 * one is not a race that shows up occasionally - it is deterministically wrong
 * for the whole time the room is not at 1x, and nothing in the system notices.
 */

test('every media-time quantity reaches wall-time arithmetic through the rate', () => {
  // The boot total: measured pipeline path (wall) plus player delta (media).
  assert.match(
    body('bootProbeAdvanceMs'),
    /mediaToWallMs\(currentDeltaMs\(nowMs\), currentPlaybackRate\(nowMs\)\)/,
  );

  const boot = readRepositoryTextFile('src/boot-calibration.ts');
  assert.match(boot, /advanceMs: micLatencyMs - backingLatencyMs \+ mediaToWallMs\(/);

  // The mapper's reference-frame shift drives both capture coordinates and the
  // live mixer read head.
  const mapper = readRepositoryTextFile('src/robot-content-timeline.ts');
  assert.match(mapper, /private mappingShiftWallMs\(\) \{\s+return mediaToWallMs\(/);
  assert.doesNotMatch(
    mapper,
    /\(this\.committedDeltaMsValue! - this\.referenceDeltaMsValue!\) \* this\.sampleRate/,
    'a media delta must not be scaled straight into capture samples',
  );

  // A transition indexes mic windows in capture samples from media quantities.
  const transition = readRepositoryTextFile('src/robot-content-transition-runtime.ts');
  assert.match(transition, /mediaToWallMs\(input\.preDeltaMs - input\.referenceDeltaMs, input\.playbackRate\)/);
  assert.match(transition, /mediaToWallMs\(state\.seekJumpMs, state\.playbackRate\)/);
  assert.match(
    transition,
    /private seekJumpSamples\(seekJumpMs: number, playbackRate: number\)/,
    'the media jump must be converted before it becomes a sample count',
  );
});

test('the room has one playback-rate source and it defaults to 1x, never to zero', () => {
  const rate = body('currentPlaybackRate');
  assert.match(rate, /currentTimelineStatus\(nowMs\)\.playbackRate/);
  assert.match(rate, /Number\.isFinite\(rate\) && rate > 0 \? rate : 1/);

  // A zero or negative rate would turn every conversion into Infinity or a
  // sign flip, so the guard lives in the conversion too.
  assert.match(
    readRepositoryTextFile('src/boot-calibration.ts'),
    /if \(!Number\.isFinite\(playbackRate\) \|\| playbackRate <= 0\) return mediaDeltaMs;/,
  );
});

/**
 * ARCHITECTURE_BOUNDARIES.md: "Revoking a media mapping is one transaction."
 *
 * A rate change invalidates the mapping for the same reason a destructive seek
 * does - every delta already folded into the reference frame was converted at
 * the old rate and cannot be rescaled in place - so it takes the same path
 * rather than growing a second, partial teardown.
 */
test('a playback-rate change revokes the content mapping through the one transaction', () => {
  const revoke = body('revokeContentMappingOnRateChange');
  assert.match(revoke, /robotContentTimeline\.matchesPlaybackRate\(rate\)/);
  assert.match(revoke, /revokeRobotContentMapping\(\{/);
  assert.doesNotMatch(
    revoke,
    /robotContentTimeline\.reset\(\)|sourceRuntime\.invalidateMapping\(\)|calibration\.fail\(/,
    'a rate change must not re-spell the teardown the shared revocation owns',
  );

  // The boot baseline is a wall-time pipeline measurement and deliberately
  // survives media mapping revocation. The ordering-only coordinator must not
  // grow boot-probe authority or a callback that clears it.
  const revocation = readRepositoryTextFile('src/relay-robot-content-mapping-revocation-coordinator.ts');
  assert.doesNotMatch(revocation, /bootProbe/i);
});

test('the telemetry seam checks the rate before anything reads the mapping', () => {
  const coordinator = readRepositoryTextFile('src/relay-youtube-telemetry-acceptance-coordinator.ts');
  const revoked = coordinator.indexOf('const revoked = dependencies.revokeContentMappingOnRateChange(');
  const validation = coordinator.indexOf('dependencies.cancelActiveContentValidation(');
  const timeline = coordinator.indexOf('dependencies.reportTimelineStatus(');

  assert.ok(revoked >= 0, 'accepted telemetry must check the rate');
  assert.ok(validation > revoked, 'validation must not be cancelled against a mapping already being retired');
  assert.ok(timeline > revoked, 'the timeline must publish after the mapping decision');

  // The revocation publishes its own timing status, so this seam must not send
  // a second one for the same telemetry.
  assert.match(coordinator, /!revoked\s*\n\s*&& Number\(input\.timelineStatus\.state\) !== 1/);
});

test('the Robot follows the room rate, so Relay must not assume its player is at 1x', () => {
  // The two halves of the same contract: source.js applies the room rate to
  // its player, and the server converts the deltas that player then reports.
  const source = readRepositoryTextFile('public/source.js');
  assert.match(source, /player\.setPlaybackRate\(desiredRate\)/);
  assert.match(server, /playbackRate: currentPlaybackRate\(nowMs\)/);
  assert.match(
    server,
    /currentPlaybackRate\(nowMs\),\s*\n\s*\);/,
    'the mapper must be told the rate its deltas were measured at',
  );
});
