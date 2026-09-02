import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const coordinator = readFileSync(
  new URL('../src/relay-source-seek-transaction-coordinator.ts', import.meta.url),
  'utf8',
);

function sourceSeekBlock() {
  const protocol = server.indexOf('const infrastructureEventProtocol = createRelayInfrastructureEventProtocol<RelaySocket>({');
  const start = server.indexOf('  sourceSeeked: (socket, payload) => {', protocol);
  const end = server.indexOf('\n  },\n});', start);
  assert.ok(protocol >= 0 && start > protocol && end > start, 'sourceSeeked block must remain identifiable');
  return server.slice(start, end);
}

test('server retains Source seek authority and mapping classification before delegation', () => {
  assert.match(
    server,
    /import \{ createRelaySourceSeekTransactionCoordinator \} from '\.\/relay-source-seek-transaction-coordinator\.js';/,
  );
  const block = sourceSeekBlock();
  assert.match(block, /infrastructureCapability\.authorized\(socket\)/);
  assert.match(block, /sourceRuntime\.canReportSeek\(socket\)/);
  assert.match(block, /robotContentTransitionRuntime\.clearPendingBoundary\(\)/);
  assert.match(block, /payload\.reason === 'follower-correction'/);
  assert.match(block, /calibrationContext\(\)/);
  assert.match(block, /robotContentTimeline\.currentDeltaMs/);
  assert.match(block, /robotContentTimeline\.referenceDeltaMs/);
  assert.match(block, /robotContentTimeline\.noteFollowerCorrection\(/);
  assert.match(block, /sourceSeekTransactionCoordinator\.handle\(\{/);

  assert.doesNotMatch(block, /robotPlayerOffset\.reset\(\)/);
  assert.doesNotMatch(block, /clearRobotContentTransition\(\)/);
  assert.doesNotMatch(block, /sourceRuntime\.invalidateMapping\(\)/);
  assert.doesNotMatch(block, /clearContentValidationBaseline\(\)/);
  assert.doesNotMatch(block, /calibration\.discardPrimedContent\(\)/);
  assert.doesNotMatch(block, /robotContentTimeline\.reset\(\)/);
  assert.doesNotMatch(block, /calibration\.fail\(/);
  assert.doesNotMatch(block, /syncAppliedCalibration\(\)/);
});

test('server composition retains concrete Source seek lifecycle effects', () => {
  assert.match(server, /const sourceSeekTransactionCoordinator = createRelaySourceSeekTransactionCoordinator<CalibrationContext>\(\{/);
  assert.match(server, /resetPlayerOffset: \(\) => robotPlayerOffset\.reset\(\)/);
  assert.match(server, /beginContentTransition: \(fromMediaTime, toMediaTime, preDeltaMs, referenceDeltaMs, context, nowMs\) => \{/);
  assert.match(server, /beginRobotContentTransition\(/);
  assert.match(server, /syncAppliedCalibration: \(\) => \{ syncAppliedCalibration\(\); \}/);
  assert.match(server, /clearContentTransition: \(\) => clearRobotContentTransition\(\)/);
  assert.match(server, /invalidateSourceMapping: \(\) => sourceRuntime\.invalidateMapping\(\)/);
  assert.match(server, /clearContentValidation: \(\) => clearContentValidationBaseline\(\)/);
  assert.match(server, /discardPrimedContent: \(\) => calibration\.discardPrimedContent\(\)/);
  assert.match(server, /resetContentTimeline: \(\) => robotContentTimeline\.reset\(\)/);
  assert.match(server, /calibrationCollecting: \(\) => calibration\.collecting/);
  assert.match(server, /failCalibration: \(message\) => calibration\.fail\(message\)/);
  assert.match(server, /reportSourceStatus: \(\) => broadcastJson\(sourceStatusPayload\(\)\)/);
  assert.match(server, /reportTimingStatus: \(\) => broadcastJson\(timingCalibrationStatusPayload\(\)\)/);
});

test('Source seek coordinator owns no infrastructure, mapping or calibration authority', () => {
  assert.doesNotMatch(
    coordinator,
    /from '\.\/(?:source-runtime|robot-content-timeline|robot-content-transition-runtime|calibration-session|timing-runtime)\.js'/,
  );
  assert.doesNotMatch(
    coordinator,
    /InfrastructureCapabilityRuntime|SourceRuntime|RobotContentTimelineMapper|RobotContentTransitionRuntime|CalibrationSession/,
  );
});
