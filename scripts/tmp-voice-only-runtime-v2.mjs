import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const sourcePath = 'scripts/tmp-voice-only-runtime.mjs';
let source = readFileSync(sourcePath, 'utf8');

function patchOnce(before, after, label) {
  assert.equal(source.split(before).length - 1, 1, label);
  source = source.replace(before, after);
}

patchOnce(
  "]) assert.equal(issueCodes.has(code), false, `${code} must not describe an intentional voice-only Take`);",
  "]) assert.equal(issueCodes.has(code), false, String(code) + ' must not describe an intentional voice-only Take');",
  'expected one nested template diagnostic',
);
patchOnce(
  'function feedMic(client, frames, value = 4_000) {',
  'function feedMic(client: RelayClient, frames: number, value = 4_000) {',
  'expected one feedMic test helper',
);
patchOnce(
  '.map((issue) => issue.code)',
  '.map((issue: { code: string }) => issue.code)',
  'expected one issue-code mapper',
);

const fixedPath = '/tmp/relay-voice-only-runtime-fixed.mjs';
writeFileSync(fixedPath, source);
await import(pathToFileURL(fixedPath).href);

function replaceRepo(path, before, after, label) {
  const content = readFileSync(path, 'utf8');
  assert.equal(content.split(before).length - 1, 1, `${path}: ${label}`);
  writeFileSync(path, content.replace(before, after));
}

// Keep the existing Song lifecycle contract intact. A live Mic only promotes
// lifecycle when the room intentionally has no Song.
replaceRepo(
  'src/product-view-model.ts',
  `  const mic = micState(input);\n  if (\n    input.readiness.components.session.active\n    && (input.roomSong.state === 1 || mic === 'live' || mic === 'reconnecting')\n  ) {\n    return 'live';\n  }\n  if (songLoaded) return 'ready';\n  return 'idle';\n`,
  `  const mic = micState(input);\n  if (songLoaded) {\n    if (input.roomSong.state === 1 && input.readiness.components.session.active) return 'live';\n    return 'ready';\n  }\n  if (\n    input.readiness.components.session.active\n    && (mic === 'live' || mic === 'reconnecting')\n  ) return 'live';\n  return 'idle';\n`,
  'expected generated mixed Song/Voice lifecycle',
);

// Robot/backing readiness stays a real system-health contract. Voice-only
// recording simply does not use that health as its Start gate.
replaceRepo(
  'src/product-view-model.ts',
  `  const songLoaded = input.roomSong.videoId !== null;\n  // Backing/Robot failures remain visible in technical readiness, but they are\n  // not a product blocker when the room intentionally has no Song.\n  const host = songLoaded ? hostAttention(input) : null;\n  if (host) return host;\n\n  const performanceActive = songLoaded\n    && input.roomSong.state === 1\n    && (lifecycle === 'live' || lifecycle === 'recording');\n`,
  `  const host = hostAttention(input);\n  if (host) return host;\n\n  const songLoaded = input.roomSong.videoId !== null;\n  const performanceActive = lifecycle === 'live' || lifecycle === 'recording';\n`,
  'expected generated host-attention suppression',
);

replaceRepo(
  'src/product-view-model.ts',
  `    actions: {\n      canStartTake: health !== 'blocked'\n        && input.readiness.components.session.active\n        && (\n          input.roomSong.videoId === null\n            ? micState(input) === 'live'\n            : input.readiness.components.backing.connected\n              && input.readiness.components.backing.streaming\n        )\n        && input.take.lifecycle !== 'recording'\n        && input.take.lifecycle !== 'finalizing',\n      canStopTake: input.take.lifecycle === 'recording',\n    },\n`,
  `    actions: {\n      canStartTake: input.readiness.components.session.active\n        && (\n          input.roomSong.videoId === null\n            ? micState(input) === 'live'\n            : health !== 'blocked'\n        )\n        && input.take.lifecycle !== 'recording'\n        && input.take.lifecycle !== 'finalizing',\n      canStopTake: input.take.lifecycle === 'recording',\n    },\n`,
  'expected generated Take readiness gate',
);

// Registration owns the Mic lease, not the room clock. Start a voice-only mix
// on the first real PCM frame so merely opening the Mic cannot perturb source,
// sync-test or calibration generations.
replaceRepo(
  'src/server.ts',
  `      if (session.active) restartLiveSourceAfterMicReconnect();\n      else startLiveSource();\n`,
  `      restartLiveSourceAfterMicReconnect();\n`,
  'expected generated publisher-register session start',
);

replaceRepo(
  'src/server.ts',
  `      if (socket === publisher && socket.role === 'publisher') {\n        if (testActive || session.active) {\n`,
  `      if (socket === publisher && socket.role === 'publisher') {\n        if (!testActive && !session.active) startLiveSource();\n        if (testActive || session.active) {\n`,
  'expected publisher PCM ingest boundary',
);

// Preserve the established Song-mode Start behavior. The new readiness check
// exists only for no-Song Takes, where real Mic audio must have arrived.
replaceRepo(
  'src/server.ts',
  `      const micStreaming = publisher?.readyState === WebSocket.OPEN\n        && nowMs - lastMicFrameAt < STREAM_LIVE_MS;\n      const backingStreaming = backing?.readyState === WebSocket.OPEN\n        && nowMs - lastBackingFrameAt < STREAM_LIVE_MS;\n      if (song.videoId === null ? !micStreaming : !backingStreaming) {\n        rejectTakeCommand(socket, 'start', 'take-not-ready');\n        return;\n      }\n`,
  `      const micStreaming = publisher?.readyState === WebSocket.OPEN\n        && nowMs - lastMicFrameAt < STREAM_LIVE_MS;\n      if (song.videoId === null && !micStreaming) {\n        rejectTakeCommand(socket, 'start', 'take-not-ready');\n        return;\n      }\n`,
  'expected generated symmetric source gate',
);

// Restore the parent PR's health regression: an explicitly armed broken Robot
// remains blocked even when the room has not loaded a Song yet.
replaceRepo(
  'test/product-view-model.test.ts',
  `  test('keeps unused Robot backing failure out of product health when there is no Song', () => {\n`,
  `  test('blocks the product when robot backing audio is unavailable even while idle', () => {\n`,
  'expected generated Robot-health test rename',
);
replaceRepo(
  'test/product-view-model.test.ts',
  `    assert.equal(model.lifecycle, 'idle');\n    assert.equal(model.health, 'healthy');\n    assert.equal(model.attention, null);\n  });\n\n  test('reports a loaded paused room as ready without treating phone-not-playing as damage', () => {\n`,
  `    assert.equal(model.lifecycle, 'idle');\n    assert.equal(model.health, 'blocked');\n    assert.equal(model.attention?.code, 'robot-audio-unavailable');\n  });\n\n  test('reports a loaded paused room as ready without treating phone-not-playing as damage', () => {\n`,
  'expected generated Robot-health assertions',
);

// The old no-Song rejection is now "no recordable room audio" rather than a
// Song requirement. This test has backing but no Mic, so it still rejects.
replaceRepo(
  'test/take-server.test.ts',
  `test('Take commands require participant identity, an active mix, a song, and the current Take id', async () => {\n`,
  `test('Take commands require participant identity, recordable room audio, and the current Take id', async () => {\n`,
  'expected old Take command test title',
);
replaceRepo(
  'test/take-server.test.ts',
  `      && message.reason === 'song-required'\n    ));\n    assert.equal(noSong.reason, 'song-required');\n`,
  `      && message.reason === 'take-not-ready'\n    ));\n    assert.equal(noSong.reason, 'take-not-ready');\n`,
  'expected old no-Song rejection contract',
);

console.log('voice-only compatibility corrections applied');
