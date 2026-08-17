import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { RelayClient, sleep, startRelay } from './helpers/harness.js';

const source = readFileSync(new URL('../public/source.js', import.meta.url), 'utf8');
const serverSource = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');

test('an unarmed Source preview cannot announce or chase authoritative seek discontinuities', () => {
  assert.match(
    source,
    /loadedVideoId !== timeline\.videoId[\s\S]{0,500}if \(armed\) send\(\{ type: 'source-seeked' \}\)/,
    'initial preview cue may position YouTube but must not invalidate active calibration',
  );
  assert.match(
    source,
    /const shouldSeek = armed\s*&&\s*Number\.isFinite\(errorSeconds\)/,
    'an unarmed paused preview must not chase the advancing phone timeline every 700 ms',
  );
});

test('server fences source-seeked from any no-longer-active Robot source', () => {
  assert.match(
    serverSource,
    /if \(payload\.type === 'source-seeked'\) \{[\s\S]{0,700}if \(socket\.isRobotSource !== undefined && socket !== activeRobotSource\) return;[\s\S]{0,200}sourceGeneration \+= 1/,
  );
});

async function freshCalibrationStatus(client: RelayClient) {
  const from = client.messages.length;
  client.send({ type: 'timing-calibration-status-request' });
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const status = client.messages.slice(from).find((message) => message.type === 'timing-calibration-status');
    if (status) return status;
    await sleep(10);
  }
  throw new Error('Timed out waiting for fresh timing-calibration-status.');
}

test('superseded Robot seek cannot erase the active Robot delta', async () => {
  const relay = await startRelay({
    RELAY_AUTO_CALIBRATE: '0',
    RELAY_CALIBRATION_PROBE: '0',
    RELAY_HEARTBEAT_MS: '60000',
  });
  try {
    const observer = await RelayClient.connect(relay);
    observer.send({ type: 'register', role: 'monitor' });
    await observer.waitForType('registered');

    const first = await RelayClient.connect(relay);
    first.send({ type: 'robot-source-hello' });
    const second = await RelayClient.connect(relay);
    second.send({ type: 'robot-source-hello' });
    await first.waitForType('robot-source-replaced');

    second.send({ type: 'robot-player-offset', offsetMs: 35 });
    await sleep(30);
    const before = await freshCalibrationStatus(observer);
    assert.equal(Math.round(before.robotPlayerOffsetMs), 35);

    first.send({ type: 'source-seeked' });
    await sleep(30);
    const afterStale = await freshCalibrationStatus(observer);
    assert.equal(
      Math.round(afterStale.robotPlayerOffsetMs),
      35,
      'a superseded Robot page must not clear timing evidence owned by the active source',
    );

    second.send({ type: 'source-seeked' });
    await sleep(30);
    const afterActive = await freshCalibrationStatus(observer);
    assert.equal(afterActive.robotPlayerOffsetMs, null, 'the active Robot seek remains a real discontinuity');

    observer.close();
    first.close();
    second.close();
  } finally {
    await relay.stop();
  }
});
