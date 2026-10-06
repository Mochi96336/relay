import type { AudioSession } from './audio-session.js';
import type { BackingRuntime } from './backing-runtime.js';
import type { CalibrationSession } from './calibration-session.js';
import { createRelayBackingActivationCoordinator } from './relay-backing-activation-coordinator.js';
import { createRelayBackingCaptureRestartCoordinator } from './relay-backing-capture-restart-coordinator.js';
import { createRelayBackingDisconnectCoordinator } from './relay-backing-disconnect-coordinator.js';
import { createRelayBackingGraceExpiryCoordinator } from './relay-backing-grace-expiry-coordinator.js';

type BackingSocket = { sampleRate?: number };

export type RelayBackingLifecycleDependencies<TSocket extends BackingSocket> = {
  readonly backing: Readonly<Pick<BackingRuntime<TSocket>,
    'socket' | 'isSocket' | 'bind' | 'detach' | 'isRobot' | 'retireRobotRoute'>>;
  readonly mix: Readonly<Pick<AudioSession, 'active' | 'retireBackingCapture' | 'setBackingExpected'>>;
  readonly calibration: Readonly<Pick<CalibrationSession, 'collecting' | 'fail'>>;
  readonly take: Readonly<{
    noteQualityEvent(event: 'backing-transport-replaced' | 'backing-transport-connected'
      | 'backing-transport-disconnected' | 'backing-capture-restarted'): void;
  }>;
  readonly commands: Readonly<{
    clearRobotContentTransition(): void;
    dropLegacyCalibrationForRobot(): void;
    abandonProbeRun(): void;
    clearContentValidationBaseline(): void;
    cancelActiveContentValidation(): boolean;
    syncAppliedCalibration(): void;
    invalidateMicTiming(reason: string): void;
    startLiveSource(): void;
    stopLiveSource(): void;
  }>;
  readonly effects: Readonly<{
    retirePrevious(previous: TSocket | null, next: TSocket, message: string): void;
    sendRegistered(socket: TSocket, robot: boolean): void;
    reportTimingStatus(): void;
    reportSourceStatus(): void;
    reportStatus(): void;
  }>;
};

/** Backing sequencing only. Admission, capture, timers, PCM and timing retain their existing owners. */
export function createRelayBackingLifecycle<TSocket extends BackingSocket>(
  dependencies: RelayBackingLifecycleDependencies<TSocket>,
) {
  const captureRestart = createRelayBackingCaptureRestartCoordinator({
    clearContentTransition: () => dependencies.commands.clearRobotContentTransition(),
    noteQualityEvent: (event) => dependencies.take.noteQualityEvent(event),
    abandonProbeRun: () => dependencies.commands.abandonProbeRun(),
    clearContentValidation: () => dependencies.commands.clearContentValidationBaseline(),
    failCalibration: (message) => dependencies.calibration.fail(message),
    syncAppliedCalibration: () => { dependencies.commands.syncAppliedCalibration(); },
    reportTimingStatus: () => dependencies.effects.reportTimingStatus(),
    reportSourceStatus: () => dependencies.effects.reportSourceStatus(),
  });
  const activation = createRelayBackingActivationCoordinator<TSocket>({
    previousBacking: () => dependencies.backing.socket,
    clearRobotContentTransition: () => dependencies.commands.clearRobotContentTransition(),
    retireReplacedCapture: () => dependencies.mix.retireBackingCapture(),
    noteQualityEvent: (event) => dependencies.take.noteQualityEvent(event),
    retirePrevious: (previous, next) => {
      dependencies.effects.retirePrevious(previous, next, 'Replaced by a newer tab capture.');
    },
    setSocketSampleRate: (socket, sampleRate) => { socket.sampleRate = sampleRate; },
    bindBacking: (registration) => dependencies.backing.bind(registration),
    setBackingExpected: () => dependencies.mix.setBackingExpected(true),
    sessionActive: () => dependencies.mix.active,
    dropLegacyCalibrationForRobot: () => dependencies.commands.dropLegacyCalibrationForRobot(),
    onReplacedCaptureActivated: () => {
      captureRestart.restart({ calibrationCollecting: dependencies.calibration.collecting });
    },
    activeBackingIsRobot: () => dependencies.backing.isRobot,
    sendRegistered: (socket, robot) => dependencies.effects.sendRegistered(socket, robot),
    startLiveSource: () => dependencies.commands.startLiveSource(),
  });
  const disconnect = createRelayBackingDisconnectCoordinator<TSocket>({
    isBacking: (socket) => dependencies.backing.isSocket(socket),
    noteDisconnected: () => dependencies.take.noteQualityEvent('backing-transport-disconnected'),
    clearRobotContentTransition: () => dependencies.commands.clearRobotContentTransition(),
    detach: (socket) => dependencies.backing.detach(socket),
    clearBackingExpectation: () => dependencies.mix.setBackingExpected(false),
    failCalibrationIfCollecting: () => {
      if (dependencies.calibration.collecting) {
        dependencies.calibration.fail('Desktop Source disconnected during calibration.');
      }
    },
    cancelContentValidationAndReport: () => {
      if (dependencies.commands.cancelActiveContentValidation()) dependencies.effects.reportTimingStatus();
    },
    reportSourceStatus: () => dependencies.effects.reportSourceStatus(),
    reportStatus: () => dependencies.effects.reportStatus(),
  });
  const graceExpiry = createRelayBackingGraceExpiryCoordinator({
    stopLiveSource: () => dependencies.commands.stopLiveSource(),
    retireRobotRoute: () => dependencies.backing.retireRobotRoute(),
    clearRobotContentTransition: () => dependencies.commands.clearRobotContentTransition(),
    invalidateMicTiming: (message) => dependencies.commands.invalidateMicTiming(message),
    reportStatus: () => dependencies.effects.reportStatus(),
  });
  return { activate: activation.activate, restartCapture: captureRestart.restart,
    disconnect: disconnect.handle, expireGrace: graceExpiry.expire };
}
