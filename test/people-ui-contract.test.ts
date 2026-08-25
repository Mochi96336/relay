import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const people = readFileSync(new URL('../public/people-ui.js', import.meta.url), 'utf8');
const peopleCss = readFileSync(new URL('../public/people-ui.css', import.meta.url), 'utf8');
const liveIa = readFileSync(new URL('../public/live-ia.js', import.meta.url), 'utf8');
const presence = readFileSync(new URL('../public/presence.js', import.meta.url), 'utf8');

test('People consumes a replayable projection over Presence authority', () => {
  assert.equal(liveIa.includes("'./people-ui.js'"), true);
  assert.match(people, /relay-presence-state/);
  assert.match(people, /window\.relayPresenceState/);
  assert.match(people, /relay-request-presence-state/);
  assert.match(presence, /window\.relayPresenceState = detail/);
  assert.match(presence, /relay-request-presence-state/);
  assert.match(presence, /new WebSocket\(wsUrl\(\)\)/);
  assert.match(presence, /type: 'session-status-request'/);

  for (const forbidden of ['WebSocket', 'session-status-request', 'release-mic', 'acquire-mic', 'relay-request-microphone']) {
    assert.equal(people.includes(forbidden), false, `people-ui.js must not own ${forbidden}`);
  }
});

test('Presence never paints visible People count or list', () => {
  assert.doesNotMatch(presence, /#participant-count|#participant-list/);
  assert.doesNotMatch(presence, /participantCount|participantList/);
  assert.match(people, /#participant-count/);
  assert.match(people, /#participant-list/);
});

test('header awareness is built from fresh connected participants, with Mic owner emphasis', () => {
  assert.match(people, /orderedParticipants\(\)\.filter\(\(participant\) => participant\.connected\)/);
  assert.match(people, /connected\.slice\(0, 3\)/);
  assert.match(people, /participant\.id === latestSession\?\.micOwnerId/);
  assert.match(people, /overflow\.textContent = `\+\$\{connected\.length - visible\.length\}`/);
  assert.match(peopleCss, /\.participant-avatar \{[\s\S]*?width: 26px;[\s\S]*?height: 26px;/);
  assert.match(peopleCss, /\.participant-avatar\.mic-owner/);
});

test('stale authority clears visible participant rows instead of flashing legacy chips', () => {
  assert.match(people, /if \(!authorityFresh\) return;/);
  assert.match(people, /participantList\.replaceChildren\(\)/);
  assert.match(people, /t\('people\.reconnecting'\)/);
  assert.doesNotMatch(presence, /participant-chip/);
});

test('People status copy stays on shared i18n and locale rerender has no race winner', () => {
  assert.match(people, /t\('people\.inRoom'\)/);
  assert.match(people, /t\('people\.status\.singing'\)/);
  assert.match(people, /t\('people\.status\.online'\)/);
  assert.match(people, /t\('people\.status\.reconnecting'\)/);
  assert.match(people, /window\.addEventListener\('relay-locale-changed', render\)/);
  assert.doesNotMatch(people, /localCopy|queueMicrotask/);
});

test('People answers who is here before identity maintenance', () => {
  assert.match(people, /heading\.textContent = t\('people\.inRoom'\)/);
  assert.match(people, /participantList\.after\(identityEditor\)/);
  assert.match(peopleCss, /\.people-popover-title/);
  assert.match(peopleCss, /\.people-popover \.identity-editor/);
});
