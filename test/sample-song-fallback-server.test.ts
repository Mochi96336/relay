import assert from 'node:assert/strict';
import test from 'node:test';
import { RelayClient, sleep, startRelay, waitForNewMessage } from './helpers/harness.js';
const videoId = 'dQw4w9WgXcQ';
test('real protocol selects sample/song fallback and withdraws it when both reporters stop', async () => {
  const server = await startRelay({ RELAY_SAMPLE_SONG_FALLBACK: 'sample-song',
    RELAY_AUTO_CALIBRATE: '0', RELAY_CALIBRATION_PROBE: '0', RELAY_CALIBRATION_VALIDATION: '0' });
  const clients: RelayClient[] = [];
  try {
    const phone = await RelayClient.connect(server, '?participant=sample-song-phone&name=Phone'); clients.push(phone);
    phone.send({ type: 'register', role: 'publisher', sampleRate: 48000, captureGeneration: 1 });
    await phone.waitForType('registered');
    phone.send({ type: 'playback-hello', playbackTransportId: 'sample-song-player', playbackGeneration: 1 });
    await phone.waitForType('playback-registered');
    const telemetry = (state: number, time: number, captureAnchor?: unknown) => phone.send({
      type: 'youtube-telemetry', videoId, state, currentTime: time, duration: 200, playbackRate: 1,
      playbackTransportId: 'sample-song-player', playbackGeneration: 1, networkRttMs: 40, captureAnchor,
    });
    phone.send({ type: 'room-song-command', commandId: 'sample-load', expectedRevision: 0, action: 'load', videoId, positionSeconds: 0 });
    await phone.waitFor(m => m.type === 'room-song-command-apply' && m.commandId === 'sample-load');
    telemetry(5, 0);
    await phone.waitFor(m => m.type === 'room-song-command-complete' && m.commandId === 'sample-load');
    phone.send({ type: 'room-song-command', commandId: 'sample-play', expectedRevision: 1, action: 'play' });
    await phone.waitFor(m => m.type === 'room-song-command-apply' && m.commandId === 'sample-play');
    telemetry(1, 0);
    await phone.waitFor(m => m.type === 'room-song-command-complete' && m.commandId === 'sample-play');
    const backing = await RelayClient.connect(server); clients.push(backing);
    backing.send({ type: 'register', role: 'backing', sampleRate: 48000, robot: true });
    await backing.waitForType('registered');
    const robot = await RelayClient.connect(server); clients.push(robot);
    robot.send({ type: 'robot-source-hello' });
    for (let i = 0; i < 5; i++) {
      const pcm = Buffer.alloc(12000 * 2);
      phone.sendPcm(pcm); backing.sendPcm(pcm);
      const at = Date.now();
      robot.send({ type: 'robot-player-offset', offsetMs: 200, songObservation: {
        videoId, state: 1, mediaSeconds: (i + 1) * .25 + .2, playbackRate: 1, observedAtUnixMs: at } });
      telemetry(1, (i + 1) * .25, { generation: 1, sampleRate: 48000,
        sampleIndex: (i + 1) * 12000, mediaDeltaSeconds: 0, uncertaintyMs: 40 });
      await sleep(30);
      backing.send({ type: 'backing-song-clock', generation: 1, sampleRate: 48000,
        sampleIndex: (i + 1) * 12000, observedAtUnixMs: at });
      await sleep(220);
    }
    async function status() {
      const from = phone.messages.length;
      phone.send({ type: 'timing-calibration-status-request' });
      return waitForNewMessage(phone, from, m => m.type === 'timing-calibration-status');
    }
    const live = await status();
    assert.equal(live.sampleSongFallback.active, true, JSON.stringify(live.sampleSongFallback));
    assert.ok(Math.abs(live.sampleSongFallback.candidateMs - 200) < 75, String(live.sampleSongFallback.candidateMs));
    assert.equal(live.activeMicLagMs, null);
    await sleep(1600);
    const stale = await status();
    assert.equal(stale.sampleSongFallback.candidateMs, null);
    assert.equal(stale.sampleSongFallback.selected, false);
  } finally {
    for (const c of clients) c.close();
    await server.stop();
  }
});
