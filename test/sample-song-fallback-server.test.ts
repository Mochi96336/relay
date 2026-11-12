import assert from 'node:assert/strict';
import test from 'node:test';
import { RelayClient, sleep, startRelay } from './helpers/harness.js';
import { joinSampleSongRoom, sampleSongVideoId as videoId } from './support/sample-song-room.js';
test('real protocol places the voice by sample/song at once and holds it when both reporters stop', async () => {
  const server = await startRelay({
    RELAY_AUTO_CALIBRATE: '0', RELAY_CALIBRATION_PROBE: '0', RELAY_CALIBRATION_VALIDATION: '0' });
  const clients: RelayClient[] = [];
  try {
    const { phone, backing, robot, telemetry, status } = await joinSampleSongRoom(server, clients);
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
    const live = await status();
    assert.equal(live.sampleSongFallback.active, true, JSON.stringify(live.sampleSongFallback));
    assert.ok(Math.abs(live.sampleSongFallback.candidateMs - 200) < 75, String(live.sampleSongFallback.candidateMs));
    assert.equal(live.activeMicLagMs, null);
    // Taken at once rather than walked to; the phone's RTT/2 (20 ms) plays no part.
    assert.ok(Math.abs(live.fallbackNetworkMs - live.sampleSongFallback.candidateMs) < 10, JSON.stringify(live));
    await sleep(1600);
    const stale = await status();
    assert.equal(stale.sampleSongFallback.candidateMs, null);
    assert.equal(stale.sampleSongFallback.selected, false);
    assert.equal(stale.sampleSongFallback.held, true);
    assert.equal(stale.sampleSongFallback.active, true);
    assert.ok(Math.abs(stale.fallbackNetworkMs - live.fallbackNetworkMs) < 10, JSON.stringify(stale));
    const journal = server.stderr().split('\n').filter(line => line.startsWith('[mic-fallback-target] '))
      .map(line => JSON.parse(line.slice('[mic-fallback-target] '.length)));
    const selected = journal.findIndex(line => line.source === 'sample-song');
    assert.ok(selected >= 0, JSON.stringify(journal));
    assert.ok(Math.abs(journal[selected].candidateMs - 200) < 75, JSON.stringify(journal[selected]));
    assert.equal(journal.slice(0, selected).every(line => line.source === 'unplaced'), true, JSON.stringify(journal));
    const lapsed = journal.slice(selected).find(line => line.source === 'held');
    assert.equal(lapsed?.change, 'source', JSON.stringify(journal));
    assert.match(String(lapsed?.reason), /-stale$/);
    assert.ok(Math.abs(lapsed!.targetMs - live.fallbackNetworkMs) < 10, JSON.stringify(lapsed));
    // The placement was one jump, made over the silent fixture Mic, and journaled.
    const jumps = server.stderr().split('\n').filter(line => line.startsWith('[mic-read-head] '))
      .map(line => JSON.parse(line.slice('[mic-read-head] '.length))).filter(line => line.kind === 'jump');
    assert.equal(jumps.length, 1, JSON.stringify(jumps));
    assert.equal(jumps[0].quiet, true);
    assert.ok(Math.abs(jumps[0].moved.networkCompensationMs - live.fallbackNetworkMs) < 10, JSON.stringify(jumps[0]));
  } finally {
    for (const c of clients) c.close();
    await server.stop();
  }
});

test('a song clock that arrives before its audio neither lapses the fallback nor blocks a far correction', async () => {
  const server = await startRelay({
    RELAY_AUTO_CALIBRATE: '0', RELAY_CALIBRATION_PROBE: '0', RELAY_CALIBRATION_VALIDATION: '0' });
  const clients: RelayClient[] = [];
  try {
    const { phone, backing, robot, telemetry, status } = await joinSampleSongRoom(server, clients);
    // The Robot bridge's order until this fix: each song clock named the end
    // of a PCM frame and was sent just before that frame. The Robot player
    // runs 200 ms ahead, then 300 ms: 100 ms is past the walk limit, so the
    // second placement has to be confirmed for a second without a lapse.
    const step = async (i: number, aheadMs: number) => {
      const pcm = Buffer.alloc(12000 * 2);
      phone.sendPcm(pcm);
      const at = Date.now();
      robot.send({ type: 'robot-player-offset', offsetMs: aheadMs, songObservation: {
        videoId, state: 1, mediaSeconds: (i + 1) * .25 + aheadMs / 1000, playbackRate: 1, observedAtUnixMs: at } });
      telemetry(1, (i + 1) * .25, { generation: 1, sampleRate: 48000,
        sampleIndex: (i + 1) * 12000, mediaDeltaSeconds: 0, uncertaintyMs: 40 });
      await sleep(30);
      backing.send({ type: 'backing-song-clock', generation: 1, sampleRate: 48000,
        sampleIndex: (i + 1) * 12000, observedAtUnixMs: at });
      backing.sendPcm(pcm);
      await sleep(220);
    };
    for (let i = 0; i < 5; i++) await step(i, 200);
    const first = await status();
    assert.ok(Math.abs(first.fallbackNetworkMs - 200) < 75, JSON.stringify(first));
    for (let i = 5; i < 15; i++) await step(i, 300);
    const corrected = await status();
    assert.ok(Math.abs(corrected.sampleSongFallback.candidateMs - 300) < 75, JSON.stringify(corrected.sampleSongFallback));
    assert.ok(Math.abs(corrected.fallbackNetworkMs - corrected.sampleSongFallback.candidateMs) < 10, JSON.stringify(corrected));

    const journal = server.stderr().split('\n').filter(line => line.startsWith('[mic-fallback-target] '))
      .map(line => JSON.parse(line.slice('[mic-fallback-target] '.length)));
    assert.equal(journal.some(line => line.reason === 'awaiting-audio' || line.reason === 'unmapped'), false,
      JSON.stringify(journal));
    // Only the change of song offset itself unsettled the backing anchor.
    const lapses = journal.filter(line => line.source === 'held');
    assert.ok(lapses.every(line => line.reason === 'backing-unsettled'), JSON.stringify(lapses));
  } finally {
    for (const c of clients) c.close();
    await server.stop();
  }
});
