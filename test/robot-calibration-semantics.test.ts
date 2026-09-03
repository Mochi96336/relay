import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  RelayClient,
  sendPcmInChunks,
  sleep,
  startRelay,
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

async function waitForNewMessage(
  client: RelayClient,
  fromIndex: number,
  predicate: (message: Record<string, any>) => boolean,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = client.messages.slice(fromIndex).find(predicate);
    if (found) return found;
    await sleep(20);
  }
  throw new Error(
    `Timed out waiting for new message. Saw: ${client.messages.slice(fromIndex).map((m) => m.type).join(', ')}`,
  );
}

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
  const restart = source.match(/function restartManualBootCalibration\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(restart, /manualBootRecalibrationCoordinator\.restart\(nowMs\)/);

  const compositionStart = source.indexOf('const manualBootRecalibrationCoordinator =');
  const compositionEnd = source.indexOf('function restartManualBootCalibration', compositionStart);
  assert.ok(
    compositionStart >= 0 && compositionEnd > compositionStart,
    'manual recalibration composition must remain identifiable',
  );
  const composition = source.slice(compositionStart, compositionEnd);
  assert.match(composition, /beginExternalRecalibration: \(\) => calibration\.beginExternalRecalibration\(\)/);
  assert.doesNotMatch(composition, /calibration\.reset\(\)/, 'manual retry must not erase known-good calibration first');
  assert.doesNotMatch(composition, /clearBootCalibrationState\(\)/, 'old confirmed boot evidence remains rollback authority');
  assert.doesNotMatch(composition, /robotPlayerOffset\.reset\(\)/, 'old confirmed Robot total still depends on its live player delta');

  const startProbe = source.match(/function maybeStartProbeCalibration\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(
    startProbe,
    /!calibration\.transactionActive/,
    'an old confirmed result must not suppress the replacement probe while a transaction is open',
  );

  const reapply = source.match(/function maybeReapplyBootCalibration\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(
    reapply,
    /calibration\.transactionActive/,
    'delta reapply must not accidentally promote old probe evidence through a new candidate transaction',
  );
  assert.match(
    reapply,
    /appliedCalibrationKind\(\) !== 'boot-probe'/,
    'boot reapply must follow confirmed authority provenance rather than the replacement candidate kind',
  );

  const appliedKind = source.match(/function appliedCalibrationKind\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(appliedKind, /timingRuntime\.appliedCalibrationKind/);
  assert.match(appliedKind, /confirmedRevision: calibration\.confirmedRevision/);
  assert.match(appliedKind, /hasConfirmedResult: calibration\.confirmedResult !== null/);

  const canApply = source.match(/function calibrationCanApply\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(canApply, /retainingConfirmedAuthority/);
  assert.match(
    canApply,
    /&& !retainingConfirmedAuthority/,
    'preferred replacement probes must not revoke a still-valid retained authority',
  );

  const sync = source.match(/function syncAppliedCalibration\([\s\S]*?\n\}/)?.[0] ?? '';
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
    /active !== result\.micLagMs/,
    'successful Robot promotion must atomically replace the previously active lag',
  );

  const failProbe = source.match(/function failProbeAttempt\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(
    failProbe,
    /timingRuntime\.restoreCandidateKindToAuthority\(\)[\s\S]*?calibration\.failPreservingPrimed/,
    'failed replacement must restore orchestration provenance before rollback publishes',
  );
  assert.doesNotMatch(
    failProbe,
    /markBootProbeAuthority/,
    'failed candidate must never relabel retained confirmed authority as boot-probe',
  );
});
