import assert from 'node:assert/strict';
import test from 'node:test';

import { RelayClient, primeStreams, sleep, startRelay, waitForNewMessage } from './helpers/harness.js';

const RATE = 48_000;
const FAST = {
  RELAY_LIVE_PREBUFFER_MS: '200',
  RELAY_AUTO_CALIBRATE: '0',
  RELAY_CALIBRATION_PROBE: '0',
};

/** Backing and a Mic publisher streaming, watched by a monitor. */
async function liveRoom(server: Awaited<ReturnType<typeof startRelay>>) {
  const backing = await RelayClient.connectBacking(server);
  const publisher = await RelayClient.connectAs(server, 'singer', 'Singer');
  publisher.send({ type: 'register', role: 'publisher', sampleRate: RATE });
  await publisher.waitForType('registered');
  const monitor = await RelayClient.connectMonitor(server);
  await primeStreams(backing, publisher);
  await monitor.waitFor((m) => m.type === 'source-status' && m.active === true);
  return { backing, publisher, monitor };
}

// Which grace expires first used to decide whether the session ended at all:
// a backing grace that ran out while the Mic's was still pending kept the room
// voice-only for that singer, and nothing stopped it once the Mic went too.
for (const [first, backingGraceMs, micGraceMs] of [
  ['backing', '100', '400'],
  ['mic', '400', '100'],
] as const) {
  test(`losing backing and Mic together ends the session when the ${first} grace expires first`, async () => {
    const server = await startRelay({
      ...FAST,
      RELAY_BACKING_GRACE_MS: backingGraceMs,
      RELAY_MIC_TRANSPORT_GRACE_MS: micGraceMs,
    });
    try {
      const { backing, publisher, monitor } = await liveRoom(server);
      const from = monitor.messages.length;
      backing.close();
      publisher.close();
      await waitForNewMessage(monitor, from, (m) => m.type === 'source-status' && m.active === false, 2_000);
    } finally {
      await server.stop();
    }
  });
}

test('releasing the Mic ends a voice-only session the backing already left', async () => {
  const server = await startRelay({
    ...FAST,
    RELAY_BACKING_GRACE_MS: '100',
    RELAY_MIC_TRANSPORT_GRACE_MS: '5000',
  });
  try {
    const presence = await RelayClient.connectAs(server, 'singer', 'Singer');
    const { backing, publisher, monitor } = await liveRoom(server);
    backing.close();
    // Past the backing grace with the singer still there: voice-only goes on.
    await sleep(400);
    const voiceOnly = monitor.messages.filter((m) => m.type === 'source-status').at(-1);
    assert.equal(voiceOnly?.active, true, 'fixture must reach the voice-only room');

    const from = monitor.messages.length;
    presence.send({ type: 'release-mic' });
    await publisher.waitForType('mic-revoked');
    await waitForNewMessage(monitor, from, (m) => m.type === 'source-status' && m.active === false, 2_000);
  } finally {
    await server.stop();
  }
});
