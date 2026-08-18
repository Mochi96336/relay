import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

function functionSection(source: string, declaration: string) {
  const start = source.indexOf(declaration);
  assert.ok(start >= 0, `${declaration} is missing`);
  const rest = source.slice(start + declaration.length);
  const nextFunctionMatch = /\n(?:async )?function /.exec(rest);
  const end = nextFunctionMatch
    ? start + declaration.length + nextFunctionMatch.index
    : source.length;
  return source.slice(start, end);
}

test('committing playback realigns to fresh authoritative time before final proof', async () => {
  const source = await readFile(new URL('../public/youtube.js', import.meta.url), 'utf8');
  const realign = functionSection(source, 'function realignCommittingHandoff');
  const viewStart = source.indexOf("window.addEventListener('relay:playback-view'");
  assert.ok(viewStart >= 0);
  const viewEnd = source.indexOf("window.addEventListener('relay:playback-prewarm-intent'", viewStart);
  const view = source.slice(viewStart, viewEnd);

  assert.match(source, /const HANDOFF_REALIGN_THRESHOLD_SECONDS = 0\.75/);
  assert.match(realign, /timeline\.handoffState !== 'committing'/);
  assert.match(realign, /timeline\.handoffId !== pendingHandoff\.handoffId/);
  assert.match(realign, /authoritativeTime = Number\(timeline\.serverTime\)/);
  assert.match(realign, /Math\.abs\(currentTime - authoritativeTime\) <= HANDOFF_REALIGN_THRESHOLD_SECONDS/);
  assert.match(realign, /player\.seekTo\(pendingHandoff\.targetTime, true\)/);
  assert.match(realign, /player\.mute\(\)/,
    'realignment must remain inaudible until the direct completion barrier');

  const realignCall = view.indexOf('realignCommittingHandoff(timeline)');
  const sameRoleReturn = view.indexOf('if (nextRole === playbackRole) return;');
  assert.ok(realignCall >= 0 && sameRoleReturn > realignCall,
    'fresh timeline updates must realign a committing target even when its role did not change');
});

test('mute provenance is fail-closed before speculative or formal preparation changes audibility', async () => {
  const source = await readFile(new URL('../public/youtube.js', import.meta.url), 'utf8');
  const speculative = functionSection(source, 'function primeSpeculativePrewarm');
  const formal = functionSection(source, 'function cuePendingHandoff');

  const speculativeRead = speculative.indexOf('Boolean(player.isMuted())');
  const speculativeMute = speculative.indexOf('player.mute()');
  const speculativeAbort = speculative.indexOf('return false;', speculativeRead);
  assert.ok(speculativeRead >= 0 && speculativeAbort > speculativeRead && speculativeMute > speculativeAbort,
    'failed speculative provenance read must abort before Relay can mute the player');
  assert.match(speculative, /Could not read player mute state for speculative prewarm/);

  const formalRead = formal.indexOf('Boolean(player.isMuted())');
  const formalMute = formal.indexOf('player.mute()');
  assert.ok(formalRead >= 0 && formalMute > formalRead,
    'formal preparation must read mute provenance before muting; an exception falls into prepare-failed');
});
