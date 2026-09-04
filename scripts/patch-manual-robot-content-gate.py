from pathlib import Path

path = Path('src/server.ts')
text = path.read_text()
old = """    if (calibrationAction.startCalibrationMode === 'boot-probe') {
      restartManualBootCalibration(nowMs);
      return;
    }

    cancelActiveContentValidation(nowMs);"""
new = """    if (calibrationAction.startCalibrationMode === 'boot-probe') {
      restartManualBootCalibration(nowMs);
      return;
    }

    if (robotProbeTimingActive() && !robotContentEvidenceMappingReady(nowMs)) {
      sendJson(socket, {
        type: 'calibration-command-rejected',
        reason: 'robot-content-mapping-pending',
      });
      return;
    }

    cancelActiveContentValidation(nowMs);"""
if old not in text:
    raise SystemExit('manual content calibration anchor not found')
path.write_text(text.replace(old, new, 1))
