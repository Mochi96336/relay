import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ui = await readFile(new URL('../public/local-file-ui.js', import.meta.url), 'utf8');

test('a file opened without the Mic is not closed by the next singer taking it', () => {
  const handler = ui.slice(ui.indexOf("localFileMix.addEventListener('change'"));
  assert.match(handler,
    /if \(kind === 'mode' \|\| kind === 'file'\) \{[\s\S]*?if \(localFileMix\.active && \(roomMicOwnerId !== window\.relayParticipantId \|\| !micActive\)\) lastMicOwnerId = null;/);
});

test('a sibling tab of the singer holding the Mic does not make this page the singer', () => {
  // Otherwise a third person taking the Mic from that tab would close the
  // file waiting here, which never sang.
  assert.match(ui, /lastMicOwnerId = roomMicOwnerId === window\.relayParticipantId && !micActive \? null : roomMicOwnerId;/);
});

test('a singer whose Mic is taken while their file plays still loses the file', () => {
  assert.match(ui, /if \(localFileMix\.active && lostMicToAnother\(\{\s*previousOwnerId: lastMicOwnerId, nextOwnerId: roomMicOwnerId, myId: window\.relayParticipantId,\s*\}\)\) localFileMix\.close\(\);/);
});
