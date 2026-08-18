import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

function topLevelFunctionSection(source: string, declaration: string) {
  const start = source.indexOf(declaration);
  assert.ok(start >= 0, `${declaration} is missing`);
  const rest = source.slice(start + declaration.length);
  const nextFunctionMatch = /\n(?:async )?function /.exec(rest);
  const end = nextFunctionMatch
    ? start + declaration.length + nextFunctionMatch.index
    : source.length;
  return source.slice(start, end);
}

test('a YouTube error during commit rolls the local target back with the server', async () => {
  const source = await readFile(new URL('../public/youtube.js', import.meta.url), 'utf8');
  const errorSection = topLevelFunctionSection(source, 'function handleError');
  const rollbackSection = topLevelFunctionSection(source, 'function rollbackCommittedHandoff');

  assert.match(errorSection, /pendingHandoff\?\.phase === 'committing'/);
  assert.match(errorSection, /rollbackCommittedHandoff\(`youtube-error-\$\{event\.data\}`\)/,
    'commit errors must move the browser back to preparing before reporting failure');
  assert.match(errorSection, /else if \(pendingHandoff\)/,
    'preparation errors may still report failure without pretending a commit rollback occurred');
  assert.match(rollbackSection, /pendingHandoff\.phase = 'preparing'/);
  assert.match(rollbackSection, /clearHandoffCommitTimer\(\)/);
});

test('late autoplay recovery work cannot cross a newer playback lifecycle', async () => {
  const source = await readFile(new URL('../public/youtube.js', import.meta.url), 'utf8');
  const clearSection = topLevelFunctionSection(source, 'function clearAutoplayRecovery');
  const completeSection = topLevelFunctionSection(source, 'function completeRoomSong');
  const prepareSection = topLevelFunctionSection(source, 'async function prepareRoomSong');
  const releaseSection = topLevelFunctionSection(source, 'function releaseRoomSong');
  const commandSection = topLevelFunctionSection(source, 'async function applyRoomSongCommand');
  const restoreSection = topLevelFunctionSection(source, 'async function restoreAuthoritativeRoom');

  assert.match(source, /let autoplayRecoveryTimer = null/);
  assert.match(source, /let autoplayRecoveryGeneration = 0/);
  assert.match(clearSection, /clearTimeout\(autoplayRecoveryTimer\)/);
  assert.match(clearSection, /autoplayRecoveryGeneration \+= 1/);
  assert.match(completeSection, /const recoveryGeneration = autoplayRecoveryGeneration/);
  assert.match(completeSection, /recoveryGeneration !== autoplayRecoveryGeneration/,
    'the 300 ms WebKit probe must be identity-fenced against later transitions');

  for (const section of [prepareSection, releaseSection, commandSection, restoreSection]) {
    assert.match(section, /clearAutoplayRecovery\(\)/,
      'a stronger playback lifecycle must retire an older completion recovery probe');
  }
});

test('outgoing release barrier survives restore but is retired before this page gets new authority', async () => {
  const source = await readFile(new URL('../public/youtube.js', import.meta.url), 'utf8');
  const retireSection = topLevelFunctionSection(source, 'function retireOutgoingReleaseBarrier');
  const prepareSection = topLevelFunctionSection(source, 'async function prepareRoomSong');
  const commandSection = topLevelFunctionSection(source, 'async function applyRoomSongCommand');
  const restoreSection = topLevelFunctionSection(source, 'async function restoreAuthoritativeRoom');

  assert.match(retireSection, /outgoingHandoffId = null/);
  assert.match(retireSection, /clearOutgoingReleaseTimer\(\)/);
  assert.match(prepareSection, /retireOutgoingReleaseBarrier\(\)/,
    'a stale H1 fallback must not pause a replacement H2 target');
  assert.match(commandSection, /retireOutgoingReleaseBarrier\(\)/,
    'an explicit server command gives this page a stronger playback lifecycle');
  assert.doesNotMatch(restoreSection, /retireOutgoingReleaseBarrier\(\)/,
    'a rejected outgoing-leader gesture may restore room state without discarding the direct-release cutover barrier');
});
