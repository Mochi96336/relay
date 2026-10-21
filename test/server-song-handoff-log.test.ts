import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const server = fs.readFileSync(path.join(process.cwd(), 'src/server.ts'), 'utf8');

function functionCode(name: string) {
  const start = server.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, name);
  return server.slice(start, server.indexOf('\n}\n', start));
}

test('every step of a song handoff leaves one [song-handoff] journal line', () => {
  assert.match(functionCode('playbackLogLabel'), /identity\.transportId\.replace\(\/\^playback-\/, ''\)\.slice\(0, 8\)/,
    'every tab id starts with "playback-", so the prefix tells tabs apart only after it');
  assert.match(functionCode('logSongHandoff'), /console\.warn\('\[song-handoff\]', JSON\.stringify\(\{ event, \.\.\.fields \}\)\)/);

  const begin = functionCode('beginPreparedSongHandoff');
  assert.match(begin, /logSongHandoff\('not-started', \{[\s\S]*?'no-playback-tab' : 'several-playback-tabs'/);
  assert.match(begin, /logSongHandoff\('not-started', \{[\s\S]*?youtubeTimeline\.handoffRefusal\(target, participants\.micOwnerId\)/);
  assert.match(begin, /logSongHandoff\('prepare', \{[\s\S]*?from: playbackLogLabel\(youtubeTimeline\.leaderIdentity\(\)\)[\s\S]*?position: plan\.serverTime,[\s\S]*?duration: room\.duration/);

  assert.match(functionCode('songHandoffReady'), /logSongHandoff\('commit'/);
  assert.match(
    functionCode('songHandoffFailed'),
    /logSongHandoff\(deferred \? 'target-retry' : 'target-failed', \{[\s\S]*?reason: journalToken\(reason\)/,
    'a failure while still preparing used to vanish without a trace',
  );
  assert.match(
    functionCode('sweepPreparedSongHandoff'),
    /youtubeTimeline\.handoffSweepReason\([\s\S]*?logSongHandoff\('abandoned', \{ handoffId, to: playbackLogLabel\(target\), reason \}\)/,
  );
  assert.match(functionCode('youtubeTelemetryAccepted'), /logSongHandoff\('complete', \{[\s\S]*?from: playbackLogLabel\(input\.previousLeader/);
  assert.match(functionCode('applyMicOwnerEffects'), /logSongHandoff\('cancelled', \{ handoffId, reason: 'mic-released' \}\)/);

  const stalled = functionCode('songHandoffStalled');
  assert.match(stalled, /payload\.handoffId !== handoffId \|\| target\.transportId !== identity\.transportId\) return;/,
    'only the live handoff\'s target is heard');
  assert.match(stalled, /logSongHandoff\('target-stalled', \{[\s\S]*?blocker: journalToken\(payload\.blocker\)/);
  assert.match(functionCode('journalToken'), /\/\^\[a-z0-9-\]\{1,40\}\$\/\.test\(value\)/);
});
