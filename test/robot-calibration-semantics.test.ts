import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { functionCode, parseTypeScriptSource, variableInitializerCode } from './support/source-contract.js';

import {
  RelayClient,
  sendPcmInChunks,
  startRelay,
  waitForNewMessage,
} from './helpers/harness.js';

const RATE = 48_000;
const ROBOT_FAST = {
  RELAY_LIVE_PREBUFFER_MS: '200',
  RELAY_CALIBRATION_TIMEOUT_MS: '1500',
  RELAY_HEARTBEAT_MS: '60000',
  RELAY_AUTO_CALIBRATE: '0',
  RELAY_CALIBRATION_AGREEMENT: '1',
  RELAY_CALIBRATION_PROBE: '1',
  RELAY_CALIBRATION_PROBE_RETRY_MS: '100',
  RELAY_CALIBRATION_PROBE_LEAD_MS: '20',
  RELAY_CALIBRATION_PROBE_SEARCH_MARGIN_MS: '200',
  RELAY_CALIBRATION_PROBE_MIN_CORRELATION: '0',
  RELAY_CALIBRATION_PROBE_ANALYSIS_TIMEOUT_MS: '3000',
};

test('Robot manual realignment starts boot-probe from fresh silent capture without YouTube telemetry', async () => {
  const server = await startRelay(ROBOT_FAST);
  try {
    const backing = await RelayClient.connect(server);
    backing.send({ type: 'register', role: 'backing', sampleRate: RATE, robot: true });
    await backing.waitForType('registered');

    const publisher = await RelayClient.connect(server);
    publisher.send({ type: 'register', role: 'publisher', sampleRate: RATE });
    await publisher.waitForType('registered');

    const robot = await RelayClient.connect(server);
    robot.send({ type: 'robot-source-hello' });

    // Silence is intentional. "Streaming" here means both PCM sample timelines
    // are advancing with fresh frames, not that Song content is audible.
    const silentHalfSecond = Buffer.alloc(Math.round(RATE * 0.5) * 2);
    await Promise.all([
      sendPcmInChunks(backing, silentHalfSecond),
      sendPcmInChunks(publisher, silentHalfSecond),
    ]);

    const from = publisher.messages.length;
    // No youtube-telemetry message is sent anywhere in this test.
    publisher.send({ type: 'start-timing-calibration' });

    const probe = await waitForNewMessage(
      publisher,
      from,
      (message) => message.type === 'play-calibration-probe' && message.target === 'mic',
      3_000,
    );

    assert.equal(probe.target, 'mic');

    backing.close();
    publisher.close();
    robot.close();
  } finally {
    await server.stop();
  }
});

test('Robot recalibration adapter preserves old authority until candidate promotion', async () => {
  const source = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
  const workflow = parseTypeScriptSource(new URL('../src/relay-boot-probe-orchestration.ts', import.meta.url),
    await readFile(new URL('../src/relay-boot-probe-orchestration.ts', import.meta.url), 'utf8'));
  const application = parseTypeScriptSource(new URL('../src/relay-calibration-orchestration.ts', import.meta.url),
    await readFile(new URL('../src/relay-calibration-orchestration.ts', import.meta.url), 'utf8'));
  const restart = source.match(/function restartManualBootCalibration\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(restart, /relayCalibrationLifecycle\.restartManualBootCalibration\(nowMs\)/);
  assert.match(functionCode(application, 'restartManualBootCalibration'), /manualBootRecalibrationCoordinator\.restart\(nowMs\)/);
  const composition = variableInitializerCode(application, 'manualBootRecalibrationCoordinator');
  assert.match(composition, /^createRelayManualBootRecalibrationCoordinator\(\{/,
    'the unique manual recalibration composition remains identifiable in its actual owner');
  assert.match(composition, /beginExternalRecalibration: \(\) => calibration\.beginExternalRecalibration\(\)/);
  assert.doesNotMatch(composition, /calibration\.reset\(\)/, 'manual retry must not erase known-good calibration first');
  assert.doesNotMatch(composition, /clearBootCalibrationState\(\)/, 'old confirmed boot evidence remains rollback authority');
  assert.doesNotMatch(composition, /robotPlayerOffset\.reset\(\)/, 'old confirmed Robot total still depends on its live player delta');

  const startProbe = functionCode(workflow, 'maybeStartProbeCalibration');
  assert.match(
    startProbe,
    /bootProbeStartAuthorityAllowsAttempt\(\{/,
    'Boot Probe authority admission must delegate to the shared start policy',
  );
  assert.match(
    startProbe,
    /calibrationTransactionActive: calibration\.transactionActive/,
    'the replacement transaction fact must cross the policy boundary',
  );

  const reapply = functionCode(workflow, 'maybeReapplyBootCalibration');
  assert.match(
    reapply,
    /calibration\.transactionActive/,
    'delta reapply must not accidentally promote old probe evidence through a new candidate transaction',
  );
  // Asserted as the two halves of the rule rather than one literal expression:
  // the decision must come from confirmed authority and must never come from the
  // in-flight candidate. Matching a single spelling made an equivalent hoist
  // look like a contract break.
  assert.match(
    reapply,
    /appliedCalibrationKind\(\)/,
    'boot reapply must follow confirmed authority provenance',
  );
  assert.doesNotMatch(
    reapply,
    /timingRuntime\.calibrationKind/,
    'boot reapply must not follow the replacement candidate kind',
  );

  const appliedKind = functionCode(application, 'appliedCalibrationKind');
  assert.match(appliedKind, /timingRuntime\.appliedCalibrationKind/);
  assert.match(appliedKind, /hasConfirmedResult: calibration\.confirmedResult !== null/);
  assert.match(appliedKind, /provisional: status\.provisional/);
  assert.doesNotMatch(
    appliedKind,
    /confirmedRevision/,
    'reading applied provenance must not synchronize or advance confirmed authority',
  );

  const settlementStart = source.indexOf('onSettled: () => {');
  const settlementEnd = source.indexOf('\n  },', settlementStart);
  assert.ok(settlementStart >= 0 && settlementEnd > settlementStart);
  const settlement = source.slice(settlementStart, settlementEnd);
  const authoritySync = settlement.indexOf('timingRuntime.syncConfirmedAuthority({');
  const mixerSync = settlement.indexOf('syncAppliedCalibration()');
  assert.ok(authoritySync >= 0 && mixerSync > authoritySync, 'confirmed provenance must settle before mixer observers run');
  assert.match(settlement, /confirmedRevision: calibration\.confirmedRevision/);
  assert.match(settlement, /hasConfirmedResult: calibration\.confirmedResult !== null/);

  const canApply = functionCode(application, 'calibrationApplicability');
assert.match(canApply, /decideCalibrationApplicability\(\{/);
assert.match(canApply, /calibrationTransactionActive: calibration\.transactionActive/);
assert.match(canApply, /calibrationProvisional: status\.provisional/);
assert.match(canApply, /hasConfirmedResult: calibration\.confirmedResult !== null/);
assert.match(canApply, /bootProbeSettled: queries\.bootProbeSettled\(nowMs\)/);
assert.doesNotMatch(canApply, /retainingConfirmedAuthority/);

  const sync = functionCode(application, 'syncAppliedCalibration');
  assert.match(sync, /const calibrationKind = appliedCalibrationKind\(\)/);
  assert.doesNotMatch(
    sync,
    /timingRuntime\.calibrationKind === 'boot-probe'/,
    'mixer authority must not be interpreted through the in-flight candidate kind',
  );
  assert.doesNotMatch(
    sync,
    /timingRuntime\.calibrationKind === 'content'/,
    'mixer authority must not be interpreted through the in-flight candidate kind',
  );
  assert.doesNotMatch(sync, /if \(active !== null\) return false;/, 'an old active Robot lag must not block promotion');
  assert.match(
    sync,
    /decideBootProbeMixerApplication\(\{/ ,
    'Boot Probe mixer application must delegate to the pure decision policy',
  );

  const failProbe = functionCode(workflow, 'failProbeAttempt');
  assert.match(
    failProbe,
    /bootProbeRuntime\.failAttempt\(target, reason, nowMs\)[\s\S]*?bootProbeFailureSettlementCoordinator\.settle\(failure\)/,
    'failed replacement must preserve probe authority mutation before delegated rollback settlement',
  );
  assert.doesNotMatch(
    failProbe,
    /markBootProbeAuthority/,
    'failed candidate must never relabel retained confirmed authority as boot-probe',
  );
});
