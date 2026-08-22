import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { RelayClient, sleep, startRelay } from './helpers/harness.js';

const source = readFileSync(new URL('../public/source.js', import.meta.url), 'utf8');
const serverSource = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');

test('an unarmed Source preview cannot announce or chase authoritative seek discontinuities', () => {
  assert.match(
    source,
    /loadedVideoId !== timeline\.videoId[\s\S]{0,500}if \(armed\) send\(\{ type: 'source-seeked', reason: 'load' \}\)/,
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
    /if \(payload\.type === 'source-seeked'\) \{[\s\S]{0,700}if \(socket\.isRobotSource !== undefined && socket !== activeRobotSource\) return;[\s\S]{0,2000}sourceGeneration \+= 1/,
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

test('a follower correction restarts the calibration window without ending the run', async () => {
  const relay = await startRelay({
    RELAY_AUTO_CALIBRATE: '0',
    RELAY_CALIBRATION_PROBE: '0',
    RELAY_HEARTBEAT_MS: '60000',
  });
  const RATE = 48_000;
  const FRAME = Buffer.alloc(Math.round(RATE * 0.02) * 2);
  let flowing: NodeJS.Timeout | null = null;
  try {
    const backing = await RelayClient.connect(relay);
    backing.send({ type: 'register', role: 'backing', sampleRate: RATE, robot: true });
    await backing.waitForType('registered');

    const publisher = await RelayClient.connect(relay);
    publisher.send({ type: 'register', role: 'publisher', sampleRate: RATE });
    await publisher.waitForType('registered');

    const robot = await RelayClient.connect(relay);
    robot.send({ type: 'robot-source-hello' });

    const observer = await RelayClient.connect(relay);
    observer.send({ type: 'register', role: 'monitor' });
    await observer.waitForType('registered');

    flowing = setInterval(() => {
      backing.sendPcm(FRAME);
      publisher.sendPcm(FRAME);
      publisher.send({
        type: 'youtube-telemetry',
        videoId: 'dQw4w9WgXcQ',
        state: 1,
        currentTime: 42,
        duration: 200,
        playbackRate: 1,
      });
    }, 40);
    await sleep(200);

    publisher.send({ type: 'start-timing-calibration' });
    await observer.waitFor(
      (message) => message.type === 'timing-calibration-status' && message.state === 'collecting',
      4_000,
    );

    // The Robot keeping step with the phone past its dead band. It breaks the
    // window in flight, because content correlation measures a sum that just
    // moved, but the run must keep going rather than waiting out the
    // auto-calibration floor before it may try again.
    robot.send({ type: 'source-seeked', reason: 'follower-correction' });
    await sleep(120);
    const afterCorrection = await freshCalibrationStatus(observer);
    assert.equal(afterCorrection.state, 'collecting', 'a follower correction must not end the run');
    assert.equal(afterCorrection.error, null);

    // A discontinuity that is not the follower keeping step still ends it.
    robot.send({ type: 'source-seeked' });
    await sleep(120);
    const afterSeek = await freshCalibrationStatus(observer);
    assert.equal(afterSeek.state, 'failed');
    assert.match(String(afterSeek.error), /seeked during calibration/);

    observer.close();
    robot.close();
    publisher.close();
    backing.close();
  } finally {
    if (flowing) clearInterval(flowing);
    await relay.stop();
  }
});

test('a follower correction is fenced out of probe staleness at the source', () => {
  // The boot probe half cannot be driven end to end yet: completing a two-leg
  // run needs the probe chime rendered into synthetic capture at the sample
  // position the detector expects, and no helper does that. Assert the fence
  // itself until one exists.
  assert.match(
    serverSource,
    /sourceGeneration exists only to make calibration stale[\s\S]{0,900}if \(!followerCorrection \|\| calibrationKind === 'content'\) \{\s*sourceGeneration \+= 1;/,
    'a follower correction must not age a probe result whose legs it cannot change',
  );
});
