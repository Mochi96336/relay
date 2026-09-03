import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { RelayClient, sleep, startRelay } from './helpers/harness.js';
import {
  functionCode,
  parseTypeScriptSource,
  variableInitializerCode,
} from './support/source-contract.js';

const source = parseTypeScriptSource(
  new URL('../public/source.js', import.meta.url),
  readFileSync(new URL('../public/source.js', import.meta.url), 'utf8'),
);
const server = parseTypeScriptSource(
  new URL('../src/server.ts', import.meta.url),
  readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'),
);
const seekCoordinator = parseTypeScriptSource(
  new URL('../src/relay-source-seek-transaction-coordinator.ts', import.meta.url),
  readFileSync(new URL('../src/relay-source-seek-transaction-coordinator.ts', import.meta.url), 'utf8'),
);

test('an unarmed Source preview cannot announce or chase authoritative seek discontinuities', () => {
  const applyTimeline = functionCode(source, 'applyTimeline');

  const loadBranch = applyTimeline.indexOf('if (loadedVideoId !== timeline.videoId) {');
  const loadCue = applyTimeline.indexOf('player.cueVideoById({', loadBranch);
  const loadAnnouncement = applyTimeline.indexOf(
    "if (armed) send({ type: 'source-seeked', reason: 'load' });",
    loadCue,
  );
  assert.ok(loadBranch >= 0, 'Source must distinguish a newly loaded video');
  assert.ok(loadCue > loadBranch, 'the preview load must happen inside the new-video branch');
  assert.ok(loadAnnouncement > loadCue, 'only an armed real load may announce a destructive seek');

  const seekDecision = applyTimeline.indexOf('const shouldSeek = armed');
  const finiteError = applyTimeline.indexOf('&& Number.isFinite(errorSeconds)', seekDecision);
  const followerBranch = applyTimeline.indexOf('if (shouldSeek) {', finiteError);
  const followerReason = applyTimeline.indexOf("reason: 'follower-correction'", followerBranch);
  const fromMediaTime = applyTimeline.indexOf('fromMediaTime: current', followerReason);
  const toMediaTime = applyTimeline.indexOf('toMediaTime: seekTarget', fromMediaTime);

  assert.ok(seekDecision >= 0, 'Source follower seeks must begin from armed authority');
  assert.ok(finiteError > seekDecision, 'follower seek authority must require a finite timeline error');
  assert.ok(followerBranch > finiteError, 'the concrete seek must remain behind the authority decision');
  assert.ok(followerReason > followerBranch, 'the production follower must identify its correction reason');
  assert.ok(
    fromMediaTime > followerReason && toMediaTime > fromMediaTime,
    'the production follower must report the concrete media mapping it changed',
  );
});

test('server fences source-seeked before classification and mapped corrections remain non-destructive', () => {
  const infrastructure = variableInitializerCode(server, 'infrastructureEventProtocol');
  const handlerStart = infrastructure.indexOf('sourceSeeked: (socket, payload) => {');
  const staleRobotFence = infrastructure.indexOf(
    'if (!sourceRuntime.canReportSeek(socket)) return;',
    handlerStart,
  );
  const mappingAttempt = infrastructure.indexOf('robotContentTimeline.noteFollowerCorrection(', staleRobotFence);
  const delegation = infrastructure.indexOf('sourceSeekTransactionCoordinator.handle({', mappingAttempt);

  assert.ok(handlerStart >= 0, 'source-seeked handler must exist');
  assert.ok(staleRobotFence > handlerStart, 'stale Robot source must be fenced before seek semantics are evaluated');
  assert.ok(mappingAttempt > staleRobotFence, 'only the active Robot may attempt follower media mapping');
  assert.ok(delegation > mappingAttempt, 'post-classification effects must begin only after mapping authority decides');
  assert.doesNotMatch(
    infrastructure.slice(mappingAttempt, delegation),
    /sourceRuntime\.invalidateMapping\(\)|calibration\.discardPrimedContent\(\)|robotPlayerOffset\.reset\(\)/,
    'classification must not perform post-seek destructive lifecycle effects',
  );

  const coordinator = functionCode(seekCoordinator, 'createRelaySourceSeekTransactionCoordinator');
  const mappedBranch = coordinator.indexOf('if (input.mappedFollowerCorrection) {');
  const mappedReturn = coordinator.indexOf("return 'mapped-follower-correction'", mappedBranch);
  const destructiveGeneration = coordinator.indexOf('dependencies.invalidateSourceMapping();', mappedReturn);
  const destructiveDiscard = coordinator.indexOf('dependencies.discardPrimedContent();', destructiveGeneration);
  assert.ok(
    mappedBranch >= 0 && mappedReturn > mappedBranch && destructiveGeneration > mappedReturn,
    'valid mapped follower correction must return before destructive invalidation',
  );
  assert.ok(
    destructiveDiscard > destructiveGeneration,
    'destructive seek must discard primed content after changing source identity',
  );
  assert.doesNotMatch(
    coordinator.slice(mappedBranch, mappedReturn),
    /invalidateSourceMapping|discardPrimedContent/,
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
