import assert from 'node:assert/strict';
import test from 'node:test';
import { RelayClient, sleep, startRelay } from './helpers/harness.js';
import { joinSampleSongRoom, sampleSongVideoId as videoId } from './support/sample-song-room.js';
import { seeded } from './support/seeded-random.js';

/**
 * The sample/song fallback pairs capture samples with song time; when each
 * message happens to arrive is not evidence. Five messages describe one
 * quarter second, on three sockets, and the network may deliver them in any
 * order: the placement must come out the same. The Robot bridge's order
 * (song clock before its PCM) lapsed the fallback every 250 ms until #661;
 * the phone's anchor travels on the control socket and its PCM on another.
 */
for (const seed of [1, 2, 3]) {
  test(`sample/song placement does not depend on arrival order (seed ${seed})`, async () => {
    const server = await startRelay({
      RELAY_AUTO_CALIBRATE: '0', RELAY_CALIBRATION_PROBE: '0', RELAY_CALIBRATION_VALIDATION: '0' });
    const clients: RelayClient[] = [];
    const next = seeded(seed * 7919);
    try {
      const { phone, backing, robot, telemetry, status } = await joinSampleSongRoom(server, clients);
      const orders: string[] = [];
      const step = async (i: number, aheadMs: number) => {
        const pcm = Buffer.alloc(12000 * 2);
        const at = Date.now();
        const sends: Record<string, () => void> = {
          micPcm: () => phone.sendPcm(pcm),
          micAnchor: () => telemetry(1, (i + 1) * .25, { generation: 1, sampleRate: 48000,
            sampleIndex: (i + 1) * 12000, mediaDeltaSeconds: 0, uncertaintyMs: 40 }),
          robotSong: () => robot.send({ type: 'robot-player-offset', offsetMs: aheadMs, songObservation: {
            videoId, state: 1, mediaSeconds: (i + 1) * .25 + aheadMs / 1000, playbackRate: 1, observedAtUnixMs: at } }),
          backingPcm: () => backing.sendPcm(pcm),
          backingClock: () => backing.send({ type: 'backing-song-clock', generation: 1, sampleRate: 48000,
            sampleIndex: (i + 1) * 12000, observedAtUnixMs: at }),
        };
        // The first frames anchor both timelines to their arrival, as live capture does.
        const names = Object.keys(sends);
        const order = i === 0 ? names : names.map(name => ({ name, key: next() }))
          .sort((a, b) => a.key - b.key).map(entry => entry.name);
        orders.push(order.join('>'));
        let spent = 0;
        for (const name of order) {
          sends[name]();
          const gap = i === 0 ? 0 : Math.floor(next() * 12);
          spent += gap;
          if (gap > 0) await sleep(gap);
        }
        await sleep(250 - spent);
      };
      for (let i = 0; i < 6; i++) await step(i, 200);
      const first = await status();
      assert.ok(Math.abs(first.fallbackNetworkMs - 200) < 75, `${JSON.stringify(first)}\n${orders.join('\n')}`);
      // 100 ms further: past the walk limit, so it needs a second of agreement without a lapse.
      for (let i = 6; i < 16; i++) await step(i, 300);
      const corrected = await status();
      const context = `${JSON.stringify(corrected.sampleSongFallback)}\n${orders.join('\n')}`;
      assert.ok(Math.abs(corrected.sampleSongFallback.candidateMs - 300) < 75, context);
      assert.ok(Math.abs(corrected.fallbackNetworkMs - corrected.sampleSongFallback.candidateMs) < 10, context);

      const journal = server.stderr().split('\n').filter(line => line.startsWith('[mic-fallback-target] '))
        .map(line => JSON.parse(line.slice('[mic-fallback-target] '.length)));
      const placed = journal.findIndex(line => line.source === 'sample-song');
      assert.ok(placed >= 0, JSON.stringify(journal));
      // Once placed, the only lapse is the Robot's own change of position.
      const lapses = journal.slice(placed).filter(line => line.source !== 'sample-song');
      assert.ok(lapses.every(line => line.source === 'held' && /-unsettled$/.test(line.reason)),
        `${JSON.stringify(lapses)}\n${orders.join('\n')}`);
      assert.ok(lapses.length <= 2, `${JSON.stringify(lapses)}\n${orders.join('\n')}`);
    } finally {
      for (const c of clients) c.close();
      await server.stop();
    }
  });
}
