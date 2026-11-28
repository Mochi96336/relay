import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ui = await readFile(new URL('../public/local-file-ui.js', import.meta.url), 'utf8');

test('a file opened without the Mic is not closed by the next singer taking it', () => {
  const handler = ui.slice(ui.indexOf("localFileMix.addEventListener('change'"));
  assert.match(handler,
    /if \(kind === 'mode' \|\| kind === 'file'\) \{[\s\S]*?if \(localFileMix\.active && roomMicOwnerId !== window\.relayParticipantId\) lastMicOwnerId = null;/);
});

test('a singer whose Mic is taken while their file plays still loses the file', () => {
  assert.match(ui, /if \(localFileMix\.active && lostMicToAnother\(\{\s*previousOwnerId: lastMicOwnerId, nextOwnerId: roomMicOwnerId, myId: window\.relayParticipantId,\s*\}\)\) localFileMix\.close\(\);/);
});
