import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

function replaceExact(path, before, after) {
  const source = readFileSync(path, 'utf8');
  const count = source.split(before).length - 1;
  assert.equal(count, 1, `${path}: expected exactly one replacement target, got ${count}`);
  writeFileSync(path, source.replace(before, after));
}

replaceExact(
  'public/live-status.js',
  `      if (song.state === 'empty') {\n        return { title: 'Mic is free', detail: 'Add a song to begin.' };\n      }\n`,
  `      if (song.state === 'empty') {\n        return { title: 'Mic is free', detail: 'Take the mic, or add a song for backing.' };\n      }\n`,
);

replaceExact(
  'public/live-status.js',
  `    const songState = status.room?.song?.state;\n\n    systemRelay.textContent`,
  `    const songState = status.room?.song?.state;\n    const micState = status.room?.mic?.state;\n\n    systemRelay.textContent`,
);

replaceExact(
  'public/live-status.js',
  `    systemAudio.textContent = audioProblem\n      ? 'Needs attention'\n      : songState === 'playing'\n        ? 'Live'\n        : songState === 'ready' || songState === 'handoff'\n          ? 'Ready'\n          : songState === 'unavailable'\n            ? 'Needs attention'\n            : 'Idle';\n`,
  `    systemAudio.textContent = audioProblem\n      ? 'Needs attention'\n      : songState === 'playing' || micState === 'live'\n        ? 'Live'\n        : micState === 'reconnecting'\n          ? 'Recovering'\n          : songState === 'ready' || songState === 'handoff'\n            ? 'Ready'\n            : songState === 'unavailable'\n              ? 'Needs attention'\n              : 'Idle';\n`,
);

replaceExact(
  'public/app.js',
  `let latestCalibration = null;\nlet pendingPublisherTakeoverOwnerId = null;\n`,
  `let latestCalibration = null;\nlet roomSongAvailable = null;\nlet pendingPublisherTakeoverOwnerId = null;\n`,
);

replaceExact(
  'public/app.js',
  `function updateCalibrateButton() {\n  const collecting = latestCalibration?.state === 'collecting';\n  calibrateButton.disabled = !publisherActive || !liveMixActive || collecting;\n\n  if (!liveMixActive) {\n`,
  `function updateCalibrateButton() {\n  const collecting = latestCalibration?.state === 'collecting';\n  calibrateButton.disabled = !publisherActive\n    || !liveMixActive\n    || roomSongAvailable !== true\n    || collecting;\n\n  if (roomSongAvailable === false) {\n    calibrateStatus.textContent = 'No song to align.';\n    return;\n  }\n\n  if (roomSongAvailable === null) {\n    calibrateStatus.textContent = 'Waiting for room state.';\n    return;\n  }\n\n  if (!liveMixActive) {\n`,
);

replaceExact(
  'public/app.js',
  `publisherButton.addEventListener('click', () => {\n`,
  `window.addEventListener('relay-product-status', (event) => {\n  const videoId = event.detail?.room?.song?.videoId;\n  roomSongAvailable = typeof videoId === 'string' && videoId.length > 0;\n  updateCalibrateButton();\n});\n\npublisherButton.addEventListener('click', () => {\n`,
);

replaceExact(
  'public/recorder.js',
  `        'song-required': 'Add a song before recording a Take.',\n        'product-blocked': 'Fix the room audio before recording a Take.',\n        'take-not-ready': 'The room is not ready to record yet.',\n`,
  `        'product-blocked': 'Fix the room audio before recording a Take.',\n        'take-not-ready': 'Start the mic before recording a voice-only Take.',\n`,
);

replaceExact(
  'test/live-ui-contract.test.ts',
  `test('formal Live copy consumes server product-status instead of rebuilding lifecycle in the browser', () => {\n  assert.match(html, /src="\\/live-status\\.js"/);\n  assert.match(liveStatus, /product-status-request/);\n  assert.match(liveStatus, /message\\.type === 'product-status'/);\n  assert.match(liveStatus, /relay-product-status/);\n  assert.match(liveStatus, /Keep this phone speaker audible for a moment\\./);\n  assert.match(liveStatus, /Robot audio unavailable/);\n  assert.doesNotMatch(liveStatus, /buildReadiness|buildProductViewModel/);\n});\n`,
  `test('formal Live copy consumes server product-status instead of rebuilding lifecycle in the browser', () => {\n  assert.match(html, /src="\\/live-status\\.js"/);\n  assert.match(liveStatus, /product-status-request/);\n  assert.match(liveStatus, /message\\.type === 'product-status'/);\n  assert.match(liveStatus, /relay-product-status/);\n  assert.match(liveStatus, /Keep this phone speaker audible for a moment\\./);\n  assert.match(liveStatus, /Robot audio unavailable/);\n  assert.doesNotMatch(liveStatus, /buildReadiness|buildProductViewModel/);\n});\n\ntest('an empty Song surface does not gate the formal Mic or imply that singing requires backing', () => {\n  assert.match(liveStatus, /Take the mic, or add a song for backing\\./);\n  assert.doesNotMatch(liveStatus, /Add a song to begin\\./);\n  assert.match(liveStatus, /songState === 'playing' \\|\\| micState === 'live'/);\n  assert.match(recorder, /Start the mic before recording a voice-only Take\\./);\n  assert.doesNotMatch(recorder, /song-required/);\n});\n`,
);

replaceExact(
  'test/adjust-ui-contract.test.ts',
  `test('Listen owns only local playback state and preserves volume while off', () => {\n`,
  `test('Timing is explicitly out of scope when the room has no Song', () => {\n  assert.equal(app.includes('roomSongAvailable'), true);\n  assert.equal(app.includes("roomSongAvailable !== true"), true);\n  assert.equal(app.includes("No song to align."), true);\n  assert.equal(app.includes("event.detail?.room?.song?.videoId"), true);\n});\n\ntest('Listen owns only local playback state and preserves volume while off', () => {\n`,
);

console.log('voice-only UI presentation contracts applied');
