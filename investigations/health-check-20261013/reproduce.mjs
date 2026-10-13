// Read-only policy reproductions. Run from the repository root:
// node --import tsx investigations/health-check-20261013/reproduce.mjs
// Originally these asserted the observed inconsistencies. After #574 they
// assert the corrected behavior; on 1bc6b50 (before the fixes) they fail.
import assert from 'node:assert/strict';
import { buildReadiness } from '../../src/readiness.ts';
import { buildProductViewModel } from '../../src/product-view-model.ts';
import { decideCalibrationApplicability } from '../../src/calibration-applicability.ts';
import { deriveRemoteStatusHealth } from '../../src/remote-status.ts';

const facts = {
  routeMode: 'robot',
  backingConnected: true, backingStreaming: true, backingSampleRate: 48_000,
  backingIsRobot: true, micConnected: true, micStreaming: true,
  micFlowObserved: true, micStartupTimedOut: false, robotSourceConnected: true,
  sessionActive: true, timelineConnected: true, timelineState: 1,
  playerOffsetMs: null, playerOffsetFresh: false,
  calibrationState: 'complete', calibrationValid: true, calibrationStale: false,
  calibrationKind: 'boot-probe', probeCorrelation: { mic: 0.8, backing: 0.9 },
  bootCalibration: { advanceMs: 80 },
};
const readiness = buildReadiness(facts);
const input = {
  readiness, participantCount: 1, micOwnerId: 'audit', micOwnerNickname: 'Audit',
  publisherControlConnected: true,
  roomSong: { videoId: 'abcdefghijk', connected: true, clockAgeMs: 0, state: 1, handoffState: 'idle' },
  take: { lifecycle: 'idle', takeId: null, qualityVerdict: null },
  timing: {
    timingMode: 'acoustic-calibration', calibrationState: 'complete',
    calibrationStale: false, alignmentClamped: false,
    requiresRobotPlayerDelta: true, robotDeltaFresh: false, robotProbeTimingActive: true,
  },
};

const applicability = decideCalibrationApplicability({
  kind: 'boot-probe', hasResult: true, stale: false,
  calibrationTransactionActive: false, calibrationProvisional: false,
  hasConfirmedResult: true, robotProbeTimingActive: true, bootProbeSettled: true,
  robotRouteActive: true, robotSourceConnected: true, roomHasSong: true,
  robotDeltaFresh: false, robotDeltaEverEstablished: true, robotContentMappingReady: false,
});
const held = buildProductViewModel(input);
const heldRemote = deriveRemoteStatusHealth(readiness);
assert.equal(applicability, 'hold');
assert.equal(readiness.components.calibration.valid, true);
// Fixed (#574): a held boot measurement is still the alignment being served.
assert.equal(held.timing.state, 'aligned');
assert.equal(held.timing.syncHeld, true);
assert.equal(held.issues.find(issue => issue.scope === 'timing'), undefined);
assert.match(heldRemote.warnings.join(' '), /holding the last boot calibration/);

const recording = buildProductViewModel({
  ...input,
  readiness: buildReadiness({ ...facts, calibrationValid: false, calibrationKind: 'none' }),
  take: { lifecycle: 'recording', takeId: 'audit', qualityVerdict: null },
  timing: { ...input.timing, timingMode: 'network-estimate', calibrationState: 'failed' },
});
// Fixed (#574): the advice waits for the recording instead of offering a refused Realign.
assert.equal(recording.issues.find(issue => issue.scope === 'timing')?.recovery, 'recalibrate-after-take');
assert.equal(recording.actions.canStartCalibration, false);
assert.equal(recording.actions.startCalibrationBlockedReason, 'take-active');

const idleRobot = deriveRemoteStatusHealth(buildReadiness({
  ...facts, micConnected: false, micStreaming: false, micFlowObserved: false,
  timelineConnected: false, timelineState: 0, calibrationState: 'idle',
  calibrationValid: false, calibrationKind: 'none', bootCalibration: null,
}));
// Fixed (#574): a Robot over a finished song with nobody singing is not degraded.
assert.equal(idleRobot.state, 'live');
assert.deepEqual(idleRobot.warnings, []);

console.log(JSON.stringify({
  heldBoot: {
    applicability, calibrationValid: readiness.components.calibration.valid,
    mixerTimingMode: input.timing.timingMode, productTiming: held.timing.state,
    issue: held.issues.find(issue => issue.scope === 'timing'),
    remoteWarnings: heldRemote.warnings,
  },
  recordingFallback: {
    issue: recording.issues.find(issue => issue.scope === 'timing'),
    canStartCalibration: recording.actions.canStartCalibration,
    blockedReason: recording.actions.startCalibrationBlockedReason,
  },
  idleRobot,
}, null, 2));
