import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RelayClient,
  laggedPair,
  primeStreams,
  sendPcmInChunks,
  startCalibrationCollecting,
  startRelay,
  waitForNewMessage,
} from './helpers/harness.js';
import { playingRoomSong } from './support/client-commands.js';

const RATE = 48_000;
const FAST = {
  RELAY_LIVE_PREBUFFER_MS: '200',
  RELAY_CALIBRATION_TIMEOUT_MS: '1500',
  RELAY_AUTO_CALIBRATE: '0',
  RELAY_CALIBRATION_AGREEMENT: '1',
  RELAY_CALIBRATION_PROBE: '0',
  RELAY_CALIBRATION_VALIDATION: '0',
};

async function completeCalibration(
  backing: RelayClient,
  publisher: RelayClient,
  songTelemetry: () => Record<string, unknown>,
  monitor: RelayClient,
  lagMs: number,
) {
  publisher.send(songTelemetry());
  await primeStreams(backing, publisher);
  await startCalibrationCollecting(publisher, monitor, async () => {
    publisher.send(songTelemetry());
    await primeStreams(backing, publisher);
  });

  const from = monitor.messages.length;
  const pair = laggedPair(8, RATE, lagMs);
  await Promise.all([
    sendPcmInChunks(backing, pair.backing),
    sendPcmInChunks(publisher, pair.mic),
  ]);
  return waitForNewMessage(
    monitor,
    from,
    (message) => message.type === 'timing-calibration-status' && message.state === 'complete',
    10_000,
  );
}

test('server keeps old confirmed alignment through failed retry and replaces it only on promotion', async () => {
  const server = await startRelay(FAST);
  const backing = await RelayClient.connectInfrastructure(server);
  const publisher = await RelayClient.connectAs(server, 'singer', 'Singer');
  const monitor = await RelayClient.connectAs(server, 'listener', 'Listener');

  try {
    backing.send({ type: 'register', role: 'backing', sampleRate: RATE });
    publisher.send({ type: 'register', role: 'publisher', sampleRate: RATE });
    monitor.send({ type: 'register', role: 'monitor' });
    await Promise.all([
      backing.waitForType('registered'),
      publisher.waitForType('registered'),
      monitor.waitForType('registered'),
    ]);
    const songTelemetry = await playingRoomSong(publisher);

    const first = await completeCalibration(backing, publisher, songTelemetry, monitor, 260);
    const oldLag = Number(first.micLagMs);
    assert.ok(Number.isFinite(oldLag));
    assert.ok(Math.abs(oldLag - 260) <= 25, `expected first calibration near 260 ms, got ${oldLag}`);
    assert.equal(first.activeMicLagMs, oldLag, 'confirmed result must already be mixer authority');

    publisher.send(songTelemetry());
    await primeStreams(backing, publisher);
    const retryCollecting = await startCalibrationCollecting(publisher, monitor, async () => {
      publisher.send(songTelemetry());
      await primeStreams(backing, publisher);
    });
    assert.equal(retryCollecting.micLagMs, oldLag, 'retry keeps the old confirmed result applied');
    assert.equal(retryCollecting.activeMicLagMs, oldLag, 'mixer must not drop old authority while collecting');

    const failureFrom = monitor.messages.length;
    const failed = await waitForNewMessage(
      monitor,
      failureFrom,
      (message) => message.type === 'timing-calibration-status' && message.state === 'failed',
      5_000,
    );
    assert.equal(failed.micLagMs, oldLag, 'failed retry rolls back to the old confirmed result');
    assert.equal(failed.activeMicLagMs, oldLag, 'failed retry must leave the mixer on old confirmed authority');
    assert.equal(failed.provisional, false);

    const promoted = await completeCalibration(backing, publisher, songTelemetry, monitor, 420);
    const newLag = Number(promoted.micLagMs);
    assert.ok(Number.isFinite(newLag));
    assert.ok(Math.abs(newLag - 420) <= 25, `expected promoted calibration near 420 ms, got ${newLag}`);
    assert.ok(Math.abs(newLag - oldLag) >= 100, 'replacement evidence must be observably different from old authority');
    assert.equal(promoted.activeMicLagMs, newLag, 'promotion switches mixer authority with the confirmed result');
  } finally {
    backing.close();
    publisher.close();
    monitor.close();
    await server.stop();
  }
});
