import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const people = readFileSync(new URL('../public/people-ui.js', import.meta.url), 'utf8');
const peopleCss = readFileSync(new URL('../public/people-ui.css', import.meta.url), 'utf8');
const liveIa = readFileSync(new URL('../public/live-ia.js', import.meta.url), 'utf8');
const presence = readFileSync(new URL('../public/presence.js', import.meta.url), 'utf8');

test('Live loads a presentation-only People projection over existing Presence authority', () => {
  assert.equal(liveIa.includes("'./people-ui.js'"), true);
  assert.match(liveIa, /import\(modulePath\)\.catch/);
  assert.match(people, /relay-session-status/);
  assert.match(people, /latestSession = event\.detail \?\? null/);
  assert.match(people, /relay-request-session-status/);
  assert.match(presence, /new WebSocket\(wsUrl\(\)\)/);
  assert.match(presence, /type: 'session-status-request'/);

  for (const forbidden of ['WebSocket', 'session-status-request', 'release-mic', 'acquire-mic', 'relay-request-microphone']) {
    assert.equal(people.includes(forbidden), false, `people-ui.js must not own ${forbidden}`);
  }
});

test('header awareness is built from real connected participants, with Mic owner emphasis', () => {
  assert.match(people, /orderedParticipants\(\)\.filter\(\(participant\) => participant\.connected\)/);
  assert.match(people, /connected\.slice\(0, 3\)/);
  assert.match(people, /participant\.id === latestSession\?\.micOwnerId/);
  assert.match(people, /overflow\.textContent = `\+\$\{connected\.length - visible\.length\}`/);
  assert.match(peopleCss, /\.participant-avatar \{[\s\S]*?width: 26px;[\s\S]*?height: 26px;/);
  assert.match(peopleCss, /\.participant-avatar\.mic-owner/);
  assert.match(peopleCss, /#participant-count \{[\s\S]*?clip-path: inset\(50%\);/);
});

test('People list says only what Presence can prove', () => {
  assert.match(people, /localCopy\('Singing', '正在唱'\)/);
  assert.match(people, /localCopy\('Online', '在線'\)/);
  assert.match(people, /localCopy\('Reconnecting', '重新連線中'\)/);
  assert.match(people, /Do not label[\s\S]*?"listening"/);
  assert.doesNotMatch(people, /聆聽中/);
  assert.match(peopleCss, /\.participant-row \{[\s\S]*?min-height: 48px;/);
});

test('People answers who is here before identity maintenance', () => {
  assert.match(people, /heading\.textContent = localCopy\('In the room', '房間裡'\)/);
  assert.match(people, /participantList\.after\(identityEditor\)/);
  assert.match(peopleCss, /\.people-popover-title/);
  assert.match(peopleCss, /\.people-popover \.identity-editor/);
});
