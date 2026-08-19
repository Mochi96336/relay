from pathlib import Path
import re

SERVER = Path('src/server.ts')
VALIDATOR = Path('src/content-calibration-validator.ts')
VALIDATOR_TEST = Path('test/content-calibration-validator.test.ts')
INTEGRATION_TEST = Path('test/content-calibration-validation-server.test.ts')


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, found {count}')
    return text.replace(old, new, 1)


def sub_once(text: str, pattern: str, replacement: str, label: str) -> str:
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.MULTILINE | re.DOTALL)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one regex match, found {count}')
    return updated


server = SERVER.read_text()

server = replace_once(
    server,
    "import { CalibrationSession, type CalibrationContext } from './calibration-session.js';\n",
    "import { CalibrationSession, type CalibrationContext } from './calibration-session.js';\n"
    "import { ContentCalibrationValidator } from './content-calibration-validator.js';\n",
    'validator import',
)

server = replace_once(
    server,
    "const AUTO_CALIBRATE = process.env.RELAY_AUTO_CALIBRATE !== '0';\n"
    "const AUTO_CALIBRATION_RETRY_MS = envMs('RELAY_AUTO_CALIBRATION_RETRY_MS', 15_000);\n"
    "let lastAutoCalibrationAt = -Infinity;\n",
    "const AUTO_CALIBRATE = process.env.RELAY_AUTO_CALIBRATE !== '0';\n"
    "const AUTO_CALIBRATION_RETRY_MS = envMs('RELAY_AUTO_CALIBRATION_RETRY_MS', 15_000);\n"
    "const CALIBRATION_AGREEMENT = Number(process.env.RELAY_CALIBRATION_AGREEMENT ?? 3);\n"
    "const CALIBRATION_TOLERANCE_MS = envMs('RELAY_CALIBRATION_TOLERANCE_MS', 25);\n"
    "const CALIBRATION_PROVISIONAL_CONFIDENCE = Number(\n"
    "  process.env.RELAY_CALIBRATION_PROVISIONAL_CONFIDENCE ?? 0.55,\n"
    ");\n"
    "const CALIBRATION_MAX_LAG_MS = envMs('RELAY_CALIBRATION_MAX_LAG_MS', 2_500);\n"
    "const CONTENT_VALIDATION_ENABLED = process.env.RELAY_CALIBRATION_VALIDATION !== '0';\n"
    "const CONTENT_VALIDATION_INTERVAL_MS = envMs(\n"
    "  'RELAY_CALIBRATION_VALIDATION_INTERVAL_MS',\n"
    "  30_000,\n"
    ");\n"
    "const CONTENT_VALIDATION_RETRY_MS = envMs(\n"
    "  'RELAY_CALIBRATION_VALIDATION_RETRY_MS',\n"
    "  10_000,\n"
    ");\n"
    "const CONTENT_VALIDATION_DEVIATION_MS = envMs(\n"
    "  'RELAY_CALIBRATION_VALIDATION_DEVIATION_MS',\n"
    "  30,\n"
    ");\n"
    "let lastAutoCalibrationAt = -Infinity;\n",
    'content validation constants',
)

server = replace_once(
    server,
    "  agreementWindows: Number(process.env.RELAY_CALIBRATION_AGREEMENT ?? 3),\n"
    "  agreementToleranceMs: envMs('RELAY_CALIBRATION_TOLERANCE_MS', 25),\n"
    "  provisionalConfidence: Number(process.env.RELAY_CALIBRATION_PROVISIONAL_CONFIDENCE ?? 0.55),\n"
    "  maxLagMs: envMs('RELAY_CALIBRATION_MAX_LAG_MS', 2_500),\n",
    "  agreementWindows: CALIBRATION_AGREEMENT,\n"
    "  agreementToleranceMs: CALIBRATION_TOLERANCE_MS,\n"
    "  provisionalConfidence: CALIBRATION_PROVISIONAL_CONFIDENCE,\n"
    "  maxLagMs: CALIBRATION_MAX_LAG_MS,\n",
    'shared calibration constants',
)

server = replace_once(
    server,
    "  onSettled: () => {\n"
    "    syncAppliedCalibration();\n"
    "    broadcastJson(timingCalibrationStatusPayload());\n"
    "    broadcastJson(sourceStatusPayload());\n"
    "  },\n"
    "});\n\n"
    "function sendJson(socket: WebSocket, payload: unknown) {\n",
    "  onSettled: () => {\n"
    "    syncAppliedCalibration();\n"
    "    broadcastJson(timingCalibrationStatusPayload());\n"
    "    broadcastJson(sourceStatusPayload());\n"
    "  },\n"
    "});\n\n"
    "let contentValidationBaselineRevision = -1;\n"
    "const contentCalibrationValidator = new ContentCalibrationValidator({\n"
    "  sampleRate: MIX_SAMPLE_RATE,\n"
    "  durationMs: TIMING_CALIBRATION_MS,\n"
    "  timeoutMs: TIMING_CALIBRATION_TIMEOUT_MS,\n"
    "  intervalMs: CONTENT_VALIDATION_INTERVAL_MS,\n"
    "  retryMs: CONTENT_VALIDATION_RETRY_MS,\n"
    "  deviationThresholdMs: CONTENT_VALIDATION_DEVIATION_MS,\n"
    "  agreementToleranceMs: CALIBRATION_TOLERANCE_MS,\n"
    "  context: calibrationContext,\n"
    "  enabled: CONTENT_VALIDATION_ENABLED,\n"
    "  maxLagMs: CALIBRATION_MAX_LAG_MS,\n"
    "  onDriftConfirmed: (result) => {\n"
    "    calibrationKind = 'content';\n"
    "    calibration.applyValidatedResult(result);\n"
    "    // applyValidatedResult increments synchronously. Keep the validator's\n"
    "    // own drift-confirmed state rather than immediately reseeding it.\n"
    "    contentValidationBaselineRevision = calibration.confirmedRevision;\n"
    "  },\n"
    "});\n\n"
    "function clearContentValidationBaseline() {\n"
    "  contentValidationBaselineRevision = -1;\n"
    "  contentCalibrationValidator.clearBaseline();\n"
    "}\n\n"
    "function syncContentValidationBaseline(nowMs: number) {\n"
    "  const confirmed = calibration.confirmedResult;\n"
    "  if (\n"
    "    calibrationKind !== 'content'\n"
    "    || confirmed === null\n"
    "    || calibrationIsStale()\n"
    "  ) {\n"
    "    if (contentCalibrationValidator.hasBaseline) clearContentValidationBaseline();\n"
    "    return false;\n"
    "  }\n\n"
    "  if (\n"
    "    contentValidationBaselineRevision === calibration.confirmedRevision\n"
    "    && contentCalibrationValidator.hasBaseline\n"
    "  ) return false;\n\n"
    "  contentCalibrationValidator.setBaseline({\n"
    "    micLagMs: confirmed.micLagMs,\n"
    "    confidence: confirmed.confidence,\n"
    "    segmentLagsMs: confirmed.segmentLagsMs,\n"
    "    context: calibrationContext(),\n"
    "  }, nowMs);\n"
    "  contentValidationBaselineRevision = calibration.confirmedRevision;\n"
    "  return true;\n"
    "}\n\n"
    "function cancelActiveContentValidation(nowMs = performance.now()) {\n"
    "  const state = contentCalibrationValidator.status(nowMs).state;\n"
    "  if (!contentCalibrationValidator.collecting && state !== 'suspect') return false;\n"
    "  contentCalibrationValidator.cancel(nowMs);\n"
    "  return true;\n"
    "}\n\n"
    "function sendJson(socket: WebSocket, payload: unknown) {\n",
    'validator construction',
)

server = replace_once(
    server,
    "    automatic: calibrationWasAutomatic,\n"
    "    autoCalibrate: AUTO_CALIBRATE,\n"
    "  };\n"
    "}\n",
    "    automatic: calibrationWasAutomatic,\n"
    "    autoCalibrate: AUTO_CALIBRATE,\n"
    "    validation: contentCalibrationValidator.status(nowMs),\n"
    "  };\n"
    "}\n",
    'validation diagnostics',
)

server = replace_once(
    server,
    "function invalidateMicTiming(message: string) {\n"
    "  clearBootCalibrationState();\n",
    "function invalidateMicTiming(message: string) {\n"
    "  clearBootCalibrationState();\n"
    "  clearContentValidationBaseline();\n",
    'timing invalidation clears validator',
)

server = replace_once(
    server,
    "function restartLiveSourceAfterMicReconnect() {\n"
    "  if (!session.active || backing?.readyState !== WebSocket.OPEN) return;\n"
    "  refreshLiveMicNetworkCompensation();\n"
    "  if (calibration.collecting) {\n"
    "    calibration.fail('Microphone reconnected during calibration. Start calibration again.');\n"
    "  }\n"
    "  broadcastJson(sourceStatusPayload());\n"
    "}\n",
    "function restartLiveSourceAfterMicReconnect() {\n"
    "  if (!session.active || backing?.readyState !== WebSocket.OPEN) return;\n"
    "  refreshLiveMicNetworkCompensation();\n"
    "  if (calibration.collecting) {\n"
    "    calibration.fail('Microphone reconnected during calibration. Start calibration again.');\n"
    "  }\n"
    "  if (cancelActiveContentValidation()) broadcastJson(timingCalibrationStatusPayload());\n"
    "  broadcastJson(sourceStatusPayload());\n"
    "}\n",
    'mic reconnect cancellation',
)

server = replace_once(
    server,
    "  clearBootCalibrationState();\n"
    "  robotPlayerOffsetMs = null;\n"
    "  robotPlayerOffsetAt = -Infinity;\n"
    "  session.stop();\n",
    "  clearBootCalibrationState();\n"
    "  clearContentValidationBaseline();\n"
    "  robotPlayerOffsetMs = null;\n"
    "  robotPlayerOffsetAt = -Infinity;\n"
    "  session.stop();\n",
    'live source stop clears validator',
)

server = replace_once(
    server,
    "      if (micRestarted) {\n"
    "        takeController.noteQualityEvent('mic-capture-restarted');\n"
    "        abandonProbeRun();\n",
    "      if (micRestarted) {\n"
    "        takeController.noteQualityEvent('mic-capture-restarted');\n"
    "        abandonProbeRun();\n"
    "        clearContentValidationBaseline();\n",
    'mic generation invalidation',
)

server = replace_once(
    server,
    "      calibration.observeMic(samples, start);\n",
    "      calibration.observeMic(samples, start);\n"
    "      contentCalibrationValidator.observeMic(samples, start);\n",
    'mic validation tap',
)

server = replace_once(
    server,
    "  if (calibration.result !== null && !calibrationIsStale()) return;\n",
    "  if (calibration.confirmedResult !== null && !calibrationIsStale()) return;\n",
    'provisional retry gate',
)

server = replace_once(
    server,
    "  calibration.start(nowMs);\n"
    "  broadcastJson(timingCalibrationStatusPayload());\n"
    "}\n\n"
    "function probeGeneration(target: ProbeTarget) {\n",
    "  calibration.start(nowMs);\n"
    "  broadcastJson(timingCalibrationStatusPayload());\n"
    "}\n\n"
    "function contentValidationPathReady(nowMs: number) {\n"
    "  if (!CONTENT_VALIDATION_ENABLED || takeBlocksCalibration()) return false;\n"
    "  if (robotProbeTimingActive()) return false;\n"
    "  if (!session.active || calibration.collecting) return false;\n"
    "  if (\n"
    "    calibrationKind !== 'content'\n"
    "    || calibration.confirmedResult === null\n"
    "    || calibrationIsStale()\n"
    "  ) return false;\n"
    "  if (backing?.readyState !== WebSocket.OPEN || publisher?.readyState !== WebSocket.OPEN) return false;\n"
    "  if (!bothStreamsFlowing(nowMs)) return false;\n"
    "  const timeline = currentTimelineStatus(nowMs);\n"
    "  return Boolean(timeline.connected) && Number(timeline.state) === 1;\n"
    "}\n\n"
    "function maybeValidateContentCalibration(nowMs: number) {\n"
    "  syncContentValidationBaseline(nowMs);\n"
    "  if (!contentCalibrationValidator.hasBaseline) return;\n\n"
    "  const state = contentCalibrationValidator.status(nowMs).state;\n"
    "  if (!contentValidationPathReady(nowMs)) {\n"
    "    if (contentCalibrationValidator.collecting || state === 'suspect') {\n"
    "      contentCalibrationValidator.cancel(nowMs);\n"
    "      broadcastJson(timingCalibrationStatusPayload());\n"
    "    }\n"
    "    return;\n"
    "  }\n\n"
    "  if (contentCalibrationValidator.tick(nowMs)) {\n"
    "    broadcastJson(timingCalibrationStatusPayload());\n"
    "  }\n"
    "  if (contentCalibrationValidator.maybeStart(nowMs)) {\n"
    "    broadcastJson(timingCalibrationStatusPayload());\n"
    "  }\n"
    "}\n\n"
    "function probeGeneration(target: ProbeTarget) {\n",
    'content validation scheduler',
)

server = replace_once(
    server,
    "function dropLegacyCalibrationForRobot() {\n"
    "  if (!robotProbeTimingActive() || calibrationKind !== 'content') return;\n"
    "  calibration.reset();\n",
    "function dropLegacyCalibrationForRobot() {\n"
    "  if (!robotProbeTimingActive() || calibrationKind !== 'content') return;\n"
    "  clearContentValidationBaseline();\n"
    "  calibration.reset();\n",
    'robot takeover clears content validator',
)

server = replace_once(
    server,
    "function restartBootCalibration(nowMs: number, automatic: boolean) {\n"
    "  calibration.reset();\n",
    "function restartBootCalibration(nowMs: number, automatic: boolean) {\n"
    "  clearContentValidationBaseline();\n"
    "  calibration.reset();\n",
    'boot calibration clears content validator',
)

server = replace_once(
    server,
    "  maybeReapplyBootCalibration(nowMs);\n"
    "  maybeAutoCalibrate(nowMs);\n\n"
    "  sweepPreparedSongHandoff(nowMs);\n",
    "  maybeReapplyBootCalibration(nowMs);\n"
    "  maybeAutoCalibrate(nowMs);\n"
    "  maybeValidateContentCalibration(nowMs);\n\n"
    "  sweepPreparedSongHandoff(nowMs);\n",
    'periodic validation call',
)

server = replace_once(
    server,
    "          takeController.noteQualityEvent('backing-capture-restarted');\n"
    "          abandonProbeRun();\n",
    "          takeController.noteQualityEvent('backing-capture-restarted');\n"
    "          abandonProbeRun();\n"
    "          clearContentValidationBaseline();\n",
    'backing generation invalidation',
)

server = replace_once(
    server,
    "        calibration.observeBacking(samples, start);\n",
    "        calibration.observeBacking(samples, start);\n"
    "        contentCalibrationValidator.observeBacking(samples, start);\n",
    'backing validation tap',
)

server = replace_once(
    server,
    "      const song = takeSongSnapshot(nowMs);\n\n"
    "      const result = takeController.start(socket.participantId, song);\n",
    "      const song = takeSongSnapshot(nowMs);\n\n"
    "      if (cancelActiveContentValidation(nowMs)) {\n"
    "        broadcastJson(timingCalibrationStatusPayload());\n"
    "      }\n"
    "      const result = takeController.start(socket.participantId, song);\n",
    'take start cancels validator',
)

server = replace_once(
    server,
    "      calibrationWasAutomatic = false;\n"
    "      calibrationKind = 'content';\n"
    "      calibration.start(nowMs);\n",
    "      cancelActiveContentValidation(nowMs);\n"
    "      calibrationWasAutomatic = false;\n"
    "      calibrationKind = 'content';\n"
    "      calibration.start(nowMs);\n",
    'manual calibration outranks validator',
)

server = replace_once(
    server,
    "      sourceGeneration += 1;\n"
    "      robotPlayerOffsetMs = null;\n"
    "      robotPlayerOffsetAt = -Infinity;\n"
    "      if (calibration.collecting) {\n"
    "        calibration.fail('The desktop player seeked during calibration. Start calibration again.');\n",
    "      sourceGeneration += 1;\n"
    "      clearContentValidationBaseline();\n"
    "      robotPlayerOffsetMs = null;\n"
    "      robotPlayerOffsetAt = -Infinity;\n"
    "      if (calibration.collecting) {\n"
    "        calibration.fail('The desktop player seeked during calibration. Start calibration again.');\n",
    'seek invalidates validator baseline',
)

server = replace_once(
    server,
    "        const timelineStatus = youtubeTimeline.statusPayload(nowMs);\n"
    "        broadcastJson(timelineStatus);\n"
    "        broadcastJson(youtubeTimeline.roomStatusPayload(nowMs));\n",
    "        const timelineStatus = youtubeTimeline.statusPayload(nowMs);\n"
    "        if (Number(timelineStatus.state) !== 1 && cancelActiveContentValidation(nowMs)) {\n"
    "          broadcastJson(timingCalibrationStatusPayload());\n"
    "        }\n"
    "        broadcastJson(timelineStatus);\n"
    "        broadcastJson(youtubeTimeline.roomStatusPayload(nowMs));\n",
    'pause cancels active validation',
)

server = replace_once(
    server,
    "        if (calibration.collecting) {\n"
    "          calibration.fail('Microphone disconnected during calibration.');\n"
    "        }\n"
    "        broadcastStatus();\n",
    "        if (calibration.collecting) {\n"
    "          calibration.fail('Microphone disconnected during calibration.');\n"
    "        }\n"
    "        if (cancelActiveContentValidation()) broadcastJson(timingCalibrationStatusPayload());\n"
    "        broadcastStatus();\n",
    'publisher disconnect cancels validation',
)

server = replace_once(
    server,
    "        if (calibration.collecting) {\n"
    "          calibration.fail('Desktop Source disconnected during calibration.');\n"
    "        }\n"
    "        cancelBackingGrace();\n",
    "        if (calibration.collecting) {\n"
    "          calibration.fail('Desktop Source disconnected during calibration.');\n"
    "        }\n"
    "        if (cancelActiveContentValidation()) broadcastJson(timingCalibrationStatusPayload());\n"
    "        cancelBackingGrace();\n",
    'backing disconnect cancels validation',
)

SERVER.write_text(server)

validator = VALIDATOR.read_text()
validator = replace_once(
    validator,
    "  clearBaseline() {\n"
    "    this.baseline = null;\n"
    "    this.suspect = null;\n"
    "    this.collector.reset();\n"
    "    this.state = 'inactive';\n"
    "    this.nextValidationAt = Number.POSITIVE_INFINITY;\n"
    "  }\n",
    "  clearBaseline() {\n"
    "    this.baseline = null;\n"
    "    this.suspect = null;\n"
    "    this.collector.reset();\n"
    "    this.state = 'inactive';\n"
    "    this.nextValidationAt = Number.POSITIVE_INFINITY;\n"
    "    this.lastMeasuredLagMs = null;\n"
    "    this.lastDeltaMs = null;\n"
    "    this.lastOutcome = null;\n"
    "    this.lastValidationAt = Number.NEGATIVE_INFINITY;\n"
    "  }\n",
    'clear structural diagnostics',
)
VALIDATOR.write_text(validator)

validator_test = VALIDATOR_TEST.read_text()
validator_test = replace_once(
    validator_test,
    "    assert.equal(status.state, 'inactive');\n"
    "    assert.equal(status.baselineLagMs, null);\n"
    "  });\n\n"
    "  test('a context change during collection cannot be promoted', () => {\n",
    "    assert.equal(status.state, 'inactive');\n"
    "    assert.equal(status.baselineLagMs, null);\n"
    "  });\n\n"
    "  test('structural invalidation clears stale validation diagnostics', () => {\n"
    "    const harness = makeHarness({ results: [analysis(325)] });\n"
    "    startDue(harness, 30_000);\n"
    "    fullWindow(harness, 0);\n"
    "    assert.equal(harness.validator.status().lastOutcome, 'stable');\n\n"
    "    harness.context.sourceGeneration = 1;\n"
    "    harness.setNow(60_000);\n"
    "    assert.equal(harness.validator.maybeStart(), false);\n"
    "    const status = harness.validator.status();\n"
    "    assert.equal(status.baselineLagMs, null);\n"
    "    assert.equal(status.lastMeasuredLagMs, null);\n"
    "    assert.equal(status.lastDeltaMs, null);\n"
    "    assert.equal(status.lastOutcome, null);\n"
    "  });\n\n"
    "  test('a context change during collection cannot be promoted', () => {\n",
    'structural diagnostics test',
)
VALIDATOR_TEST.write_text(validator_test)

INTEGRATION_TEST.write_text(r'''import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  RelayClient,
  laggedPair,
  pulseTrain,
  sendPcmInChunks,
  sleep,
  startRelay,
  toInt16,
  type RelayServer,
} from './helpers/harness.js';

const RATE = 48_000;
const FAST = {
  RELAY_LIVE_PREBUFFER_MS: '200',
  RELAY_CALIBRATION_TIMEOUT_MS: '5000',
  RELAY_HEARTBEAT_MS: '60000',
  RELAY_AUTO_CALIBRATE: '0',
  RELAY_CALIBRATION_AGREEMENT: '1',
  RELAY_CALIBRATION_PROBE: '0',
  RELAY_CALIBRATION_VALIDATION: '1',
  RELAY_CALIBRATION_VALIDATION_INTERVAL_MS: '50',
  RELAY_CALIBRATION_VALIDATION_RETRY_MS: '50',
  RELAY_CALIBRATION_VALIDATION_DEVIATION_MS: '30',
};

const playingTelemetry = {
  type: 'youtube-telemetry',
  videoId: 'dQw4w9WgXcQ',
  state: 1,
  currentTime: 42,
  duration: 200,
  playbackRate: 1,
  networkRttMs: 40,
};

function tone(seconds: number, gain = 0.6, seed = 5) {
  return toInt16(pulseTrain(Math.round(RATE * seconds), RATE, seed), gain);
}

async function liveSession(server: RelayServer) {
  const backing = await RelayClient.connect(server);
  backing.send({ type: 'register', role: 'backing', sampleRate: RATE });
  await backing.waitForType('registered');

  const publisher = await RelayClient.connect(server);
  publisher.send({ type: 'register', role: 'publisher', sampleRate: RATE });
  await publisher.waitForType('registered');

  const monitor = await RelayClient.connect(server);
  monitor.send({ type: 'register', role: 'monitor' });
  await monitor.waitForType('registered');

  return { backing, publisher, monitor };
}

async function waitForNewMessage(
  client: RelayClient,
  fromIndex: number,
  predicate: (message: Record<string, any>) => boolean,
  timeoutMs = 8_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = client.messages.slice(fromIndex).find(predicate);
    if (found) return found;
    await sleep(20);
  }
  throw new Error(
    `Timed out waiting for message. Saw: ${client.messages.slice(fromIndex).map((m) => m.type).join(', ')}`,
  );
}

async function primeStreams(backing: RelayClient, publisher: RelayClient) {
  await Promise.all([
    sendPcmInChunks(backing, tone(0.5, 0.8)),
    sendPcmInChunks(publisher, tone(0.5, 0.4)),
  ]);
}

async function establishBaseline(
  backing: RelayClient,
  publisher: RelayClient,
  monitor: RelayClient,
  lagMs = 260,
) {
  publisher.send(playingTelemetry);
  await primeStreams(backing, publisher);
  publisher.send({ type: 'start-timing-calibration' });
  await monitor.waitFor((m) => m.type === 'timing-calibration-status' && m.state === 'collecting');

  const pair = laggedPair(8, RATE, lagMs, 7);
  await Promise.all([
    sendPcmInChunks(backing, pair.backing),
    sendPcmInChunks(publisher, pair.mic),
  ]);

  return monitor.waitFor(
    (m) => m.type === 'timing-calibration-status'
      && m.state === 'complete'
      && m.calibrationKind === 'content',
    10_000,
  );
}

describe('continuous content calibration validation server policy', () => {
  test('single drift evidence cannot move alignment; a second agreeing window can', async () => {
    const server = await startRelay(FAST);
    try {
      const { backing, publisher, monitor } = await liveSession(server);
      const baseline = await establishBaseline(backing, publisher, monitor);
      const baselineLag = Number(baseline.micLagMs);
      assert.ok(Number.isFinite(baselineLag));

      const firstStart = monitor.messages.length;
      await waitForNewMessage(
        monitor,
        firstStart,
        (m) => m.type === 'timing-calibration-status'
          && m.validation?.state === 'collecting',
        4_000,
      );

      const firstDrift = laggedPair(8, RATE, 360, 31);
      await Promise.all([
        sendPcmInChunks(backing, firstDrift.backing),
        sendPcmInChunks(publisher, firstDrift.mic),
      ]);

      const suspectFrom = monitor.messages.length;
      const suspect = await waitForNewMessage(
        monitor,
        Math.max(firstStart, suspectFrom - 4),
        (m) => m.type === 'timing-calibration-status'
          && m.validation?.lastOutcome === 'suspect'
          && m.validation?.suspectLagMs !== null,
        4_000,
      );
      assert.ok(
        Math.abs(Number(suspect.validation.lastMeasuredLagMs) - baselineLag) > 30,
        'first validation should be a real deviation',
      );

      const beforePromotion = monitor.latest('source-status');
      assert.ok(beforePromotion);
      assert.equal(
        Math.round(Number(beforePromotion.activeCalibratedMicLagMs)),
        Math.round(baselineLag),
        'one deviating window must not change mixer alignment',
      );

      const confirmFrom = monitor.messages.length;
      await waitForNewMessage(
        monitor,
        confirmFrom,
        (m) => m.type === 'timing-calibration-status'
          && m.validation?.state === 'collecting'
          && m.validation?.suspectLagMs !== null,
        4_000,
      );

      const secondDrift = laggedPair(8, RATE, 355, 47);
      await Promise.all([
        sendPcmInChunks(backing, secondDrift.backing),
        sendPcmInChunks(publisher, secondDrift.mic),
      ]);

      const promoted = await waitForNewMessage(
        monitor,
        confirmFrom,
        (m) => m.type === 'timing-calibration-status'
          && m.validation?.lastOutcome === 'drift-confirmed',
        8_000,
      );
      assert.ok(Math.abs(Number(promoted.micLagMs) - baselineLag) > 30);

      const source = await waitForNewMessage(
        monitor,
        confirmFrom,
        (m) => m.type === 'source-status'
          && m.timingMode === 'acoustic-calibration'
          && Math.abs(Number(m.activeCalibratedMicLagMs) - Number(promoted.micLagMs)) < 1,
        4_000,
      );
      assert.equal(
        Math.round(Number(source.activeCalibratedMicLagMs)),
        Math.round(Number(promoted.validation.lastMeasuredLagMs)),
        'confirmed drift promotes the newest agreeing measurement',
      );

      backing.close();
      publisher.close();
      monitor.close();
    } finally {
      await server.stop();
    }
  });
});
''')

print('content calibration validation patch applied')
