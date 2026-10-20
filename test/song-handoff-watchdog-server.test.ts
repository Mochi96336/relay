import assert from 'node:assert/strict';
import test from 'node:test';

import { participantIdFor, RelayClient, startRelay } from './helpers/harness.js';
import { playRoomSong, registerPlayback } from './support/client-commands.js';
import { youtubeTelemetry } from './support/youtube-telemetry.js';

const RATE = 48_000;
const VIDEO = 'dQw4w9WgXcQ';
const FAST = {
  RELAY_AUTO_CALIBRATE: '0',
};

const A_ID = participantIdFor('A');

async function playback(
  server: Awaited<ReturnType<typeof startRelay>>,
  name: string,
  transportId: string,
) {
  const client = await RelayClient.connectAs(server, name);
  await registerPlayback(client, transportId);
  return client;
}

async function publisher(
  server: Awaited<ReturnType<typeof startRelay>>,
  name: string,
  takeoverExpectedOwnerId?: string,
) {
  const client = await RelayClient.connectAs(server, name);
  client.send({
    type: 'register',
    role: 'publisher',
    sampleRate: RATE,
    captureGeneration: 1,
    ...(takeoverExpectedOwnerId !== undefined ? { takeoverExpectedOwnerId } : {}),
  });
  await client.waitFor((message) => message.type === 'registered' && message.role === 'publisher');
  return client;
}

function telemetry(currentTime: number, overrides: Record<string, unknown> = {}) {
  return { type: 'youtube-telemetry', ...youtubeTelemetry({ currentTime, ...overrides }) };
}

test('server cancels a stuck commit without depending on the target client watchdog', async () => {
  const server = await startRelay(FAST);
  try {
    const aPlayback = await playback(server, 'A', 'playback-tab-a');
    const aPublisher = await publisher(server, 'A');
    await playRoomSong(aPlayback, { positionSeconds: 10, prefix: 'watchdog' });

    const bPlayback = await playback(server, 'B', 'playback-tab-b');
    bPlayback.send({ type: 'playback-mic-intent' });
    await bPlayback.waitForType('playback-mic-intent-registered');
    const bPublisher = await publisher(server, 'B', A_ID);

    const prepare = await bPlayback.waitForType('song-handoff-prepare');
    bPlayback.send({ type: 'song-handoff-ready', handoffId: prepare.handoffId });
    const commit = await bPlayback.waitForType('song-handoff-commit');
    assert.equal(commit.handoffId, prepare.handoffId);

    // Do not send target playback telemetry and do not send song-handoff-failed.
    // The server's own 5 s commit deadline must be sufficient to escape.
    const cancelled = await bPlayback.waitForType('song-handoff-cancelled', 7_000);
    assert.equal(cancelled.type, 'song-handoff-cancelled');

    aPlayback.send({ type: 'youtube-timeline-request' });
    const status = await aPlayback.waitFor((message) => (
      message.type === 'youtube-timeline-status'
      && message.handoffState === 'idle'
      && message.playbackLeaderParticipantId === A_ID
    ));
    assert.equal(status.playbackTransportId, 'playback-tab-a');

    // Failed-handoff holdover is deliberately narrow: A may keep the existing
    // playing song continuous after Mic ownership already moved to B. Fence the
    // proof to messages received after this telemetry so waitFor() cannot reuse
    // an earlier CUED/PLAYING status from its retained message history.
    const continuationStart = aPlayback.messages.length;
    aPlayback.send(telemetry(Number(status.serverTime)));
    const continued = await aPlayback.waitFor((message) => (
      aPlayback.messages.indexOf(message) >= continuationStart
      && message.type === 'youtube-timeline-status'
      && message.playbackLeaderParticipantId === A_ID
      && message.handoffState === 'idle'
      && Number(message.ageMs) < 1_000
    ));
    assert.equal(continued.state, 1);

    aPlayback.close();
    aPublisher.close();
    bPlayback.close();
    bPublisher.close();
  } finally {
    await server.stop();
  }
});
