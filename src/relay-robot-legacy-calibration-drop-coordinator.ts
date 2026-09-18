type CalibrationKind = 'none' | 'content' | 'boot-probe';

type RelayRobotLegacyCalibrationDropDependencies = {
  robotRouteActive: () => boolean;
  calibrationKind: () => CalibrationKind;
  bootProbeSettled: () => boolean;
  clearContentValidationBaseline: () => void;
  resetCalibration: () => void;
  clearCalibrationKind: () => void;
  resetAutoCalibrationSchedule: () => void;
  syncAppliedCalibration: () => void;
};

export function createRelayRobotLegacyCalibrationDropCoordinator(
  dependencies: RelayRobotLegacyCalibrationDropDependencies,
) {
  return {
    drop() {
      if (!dependencies.robotRouteActive() || dependencies.calibrationKind() !== 'content') return;
      if (dependencies.bootProbeSettled()) return;

      dependencies.clearContentValidationBaseline();
      dependencies.resetCalibration();
      dependencies.clearCalibrationKind();
      dependencies.resetAutoCalibrationSchedule();
      dependencies.syncAppliedCalibration();
    },
  };
}
