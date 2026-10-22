import assert from 'node:assert/strict';
import test from 'node:test';

import { RelayClient, participantIdFor, sleep, startRelay, waitForNewMessage } from './helpers/harness.js';
import { completeRoomSongCommand, playRoomSong, registerPlayback, requestProductStatus } from './support/client-commands.js';
import { youtubeTelemetry } from './support/youtube-telemetry.js';

// Real sockets and real server timers: no injected ProductStatus or altered clock limits.
test('paused playback can disconnect beyond the blocking threshold and resume with fresh clock authority', async () => {
  const server = await startRelay({ RELAY_AUTO_CALIBRATE: '0' });
  let backingTimer: ReturnType<typeof setInterval> | undefined;
  try {
    const backing = await RelayClient.connectBacking(server);
    backing.sendPcm(Buffer.alloc(48_000 * 2 * 0.1));
    backingTimer = setInterval(() => backing.sendPcm(Buffer.alloc(48_000 * 2 * 0.02)), 20);
    const observer = await RelayClient.connectAs(server, 'clock-observer');
    const controller = await RelayClient.connectAs(server, 'clock-controller');
    const transportId = 'warning-controller-tab';
    await registerPlayback(controller, transportId);
    await playRoomSong(controller, { prefix: 'warning-clock' });
    await requestProductStatus(observer, status => status.room.song.state === 'playing');

    await completeRoomSongCommand(controller,
      { commandId: 'warning-pause', expectedRevision: 2, action: 'pause' },
      { type: 'youtube-telemetry', ...youtubeTelemetry({ state: 2, currentTime: 10.05 }) });
    controller.close();
    await sleep(16_000);
    const paused = await requestProductStatus(observer, status => status.room.song.state === 'ready');
    assert.ok(!paused.issues.some((issue: any) => issue.code === 'song-clock-unavailable'));
    assert.equal(paused.health, 'healthy', 'healthy backing is independent of the offline paused controller');

    const disconnectedFrom = observer.messages.length;
    observer.send({ type: 'youtube-timeline-request' });
    const offline = await waitForNewMessage(observer, disconnectedFrom, message => message.type === 'youtube-timeline-status');
    assert.equal(offline.state, 2);
    assert.equal(offline.connected, false);
    assert.ok(offline.clockAgeMs > 15_000);

    const returned = await RelayClient.connectAs(server, 'clock-controller');
    await registerPlayback(returned, transportId);
    const resumed = { type: 'youtube-telemetry', ...youtubeTelemetry({ state: 1, currentTime: 10.05,
      playbackTransportId: transportId, playbackGeneration: 1 }) };
    await completeRoomSongCommand(returned,
      { commandId: 'warning-resume', expectedRevision: 3, action: 'play' }, resumed);
    const product = await requestProductStatus(observer, status => status.room.song.state === 'playing');
    assert.ok(!product.issues.some((issue: any) => issue.code === 'song-clock-unavailable'));
    assert.equal(product.health, 'healthy');

    const from = returned.messages.length;
    returned.send({ ...resumed, currentTime: 10.15 });
    returned.send({ type: 'youtube-timeline-request' });
    const timeline = await waitForNewMessage(returned, from, message => message.type === 'youtube-timeline-status'
      && message.connected === true && message.state === 1 && message.youtubeTime >= 10.15);
    assert.equal(timeline.playbackLeaderParticipantId, participantIdFor('clock-controller'));
    assert.equal(timeline.playbackTransportId, transportId);
    assert.ok(timeline.serverTime >= 10 && timeline.serverTime < 12, JSON.stringify(timeline));
    assert.ok(timeline.clockAgeMs < 1_500);
    assert.ok(!returned.messages.some(message => message.type === 'youtube-telemetry-rejected'
      || message.type === 'room-song-telemetry-rejected'));
    returned.close();
    observer.close();
    backing.close();
  } finally {
    clearInterval(backingTimer);
    await server.stop();
  }
});
