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
    'an armed real load must carry destructive seek identity',
  );
  assert.match(
    source,
    /if \(shouldSeek\)[\s\S]{0,700}reason: 'follower-correction'[\s\S]{0,200}fromMediaTime: current[\s\S]{0,200}toMediaTime: seekTarget/,
    'the production follower must identify the concrete media mapping it changed',
  );
  assert.match(
    source,
    /const shouldSeek = armed\s*&&\s*Number\.isFinite\(errorSeconds\)/,
    'an unarmed paused preview must not chase the advancing phone timeline every 700 ms',
  );
});

test('server fences source-seeked from any no-longer-active Robot source', () => {
  const handlerStart = serverSource.indexOf("if (payload.type === 'source-seeked') {");
  const handlerEnd = serverSource.indexOf("if (payload.type === 'set-vocal-fine-tune') {", handlerStart);
  const staleRobotFence = serverSource.indexOf(
    'if (socket.isRobotSource !== undefined && socket !== activeRobotSource) return;',
    handlerStart,
  );
  const mappingAttempt = serverSource.indexOf('robotContentTimeline.noteFollowerCorrection(', staleRobotFence);
  const mappedBranch = serverSource.indexOf('if (mappedFollowerCorrection) {', mappingAttempt);
  const mappedReturn = serverSource.indexOf('return;', mappedBranch);
  const destructiveGeneration = serverSource.indexOf('sourceGeneration += 1;', mappedReturn);
  const destructiveDiscard = serverSource.indexOf('calibration.discardPrimedContent();', destructiveGeneration);

  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart, 'source-seeked handler must exist');
  assert.ok(staleRobotFence > handlerStart, 'stale Robot source must be fenced before seek semantics are evaluated');
  assert.ok(mappingAttempt > staleRobotFence, 'only the active Robot may attempt follower media mapping');
  assert.ok(mappedBranch > mappingAttempt && mappedReturn > mappedBranch, 'valid mapped follower correction must return without destructive invalidation');
  assert.ok(
    destructiveGeneration > mappedReturn && destructiveGeneration < handlerEnd,
    'unmapped/load/manual seek must fall through to source-generation invalidation',
  );
  assert.ok(
    destructiveDiscard > destructiveGeneration && destructiveDiscard < handlerEnd,
    'destructive seek must discard primed content after changing source identity',
  );
  assert.doesNotMatch(
    serverSource.slice(mappedBranch, mappedReturn),
    /sourceGeneration \+= 1/,
    'a concretely mapped follower correction preserves source identity',
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
