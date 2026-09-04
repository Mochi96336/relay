from pathlib import Path

# calibration-start-policy.ts
path = Path('src/calibration-start-policy.ts')
text = path.read_text()
old = """  | 'sources-not-connected'
  | 'sources-not-streaming'
  | 'phone-not-playing';"""
new = """  | 'sources-not-connected'
  | 'sources-not-streaming'
  | 'content-mapping-pending'
  | 'phone-not-playing';"""
if old not in text:
    raise SystemExit('block reason anchor not found')
text = text.replace(old, new, 1)

old = """  backingIsRobot?: boolean;
  robotSourceConnected?: boolean;
  timelineConnected: boolean;"""
new = """  backingIsRobot?: boolean;
  robotSourceConnected?: boolean;
  /** Whether Robot backing can currently be mapped into new content-correlation evidence. */
  contentEvidenceReady?: boolean;
  timelineConnected: boolean;"""
if old not in text:
    raise SystemExit('facts anchor not found')
text = text.replace(old, new, 1)

old = """  if (!facts.timelineConnected || facts.timelineState !== 1) {
    return { ok: false, mode, reason: 'phone-not-playing' };
  }
  return { ok: true, mode };"""
new = """  if (!facts.timelineConnected || facts.timelineState !== 1) {
    return { ok: false, mode, reason: 'phone-not-playing' };
  }
  if (facts.contentEvidenceReady === false) {
    return { ok: false, mode, reason: 'content-mapping-pending' };
  }
  return { ok: true, mode };"""
if old not in text:
    raise SystemExit('content decision anchor not found')
path.write_text(text.replace(old, new, 1))

# product-view-model.ts
path = Path('src/product-view-model.ts')
text = path.read_text()
old = """    /** Whether manual calibration should use the Robot boot-probe path. */
    robotProbeTimingActive?: boolean;
    robotDeltaFresh: boolean;"""
new = """    /** Whether manual calibration should use the Robot boot-probe path. */
    robotProbeTimingActive?: boolean;
    /** Whether a content-mode calibration can accept Robot backing evidence now. */
    contentEvidenceReady?: boolean;
    robotDeltaFresh: boolean;"""
if old not in text:
    raise SystemExit('product timing input anchor not found')
text = text.replace(old, new, 1)

old = """    robotProbeTimingActive: input.timing.robotProbeTimingActive === true,
    backingIsRobot: input.readiness.components.backing.robot,"""
new = """    robotProbeTimingActive: input.timing.robotProbeTimingActive === true,
    contentEvidenceReady: input.timing.contentEvidenceReady,
    backingIsRobot: input.readiness.components.backing.robot,"""
if old not in text:
    raise SystemExit('product policy wiring anchor not found')
path.write_text(text.replace(old, new, 1))

# server.ts
path = Path('src/server.ts')
text = path.read_text()
old = """      requiresRobotPlayerDelta: robotProbeTimingActive() && timingRuntime.calibrationKind === 'boot-probe',
      robotProbeTimingActive: robotProbeTimingActive(),
      robotDeltaFresh: robotDeltaIsFresh(nowMs),"""
new = """      requiresRobotPlayerDelta: robotProbeTimingActive() && timingRuntime.calibrationKind === 'boot-probe',
      robotProbeTimingActive: robotProbeTimingActive(),
      contentEvidenceReady: robotContentEvidenceMappingReady(nowMs),
      robotDeltaFresh: robotDeltaIsFresh(nowMs),"""
if old not in text:
    raise SystemExit('server product timing anchor not found')
text = text.replace(old, new, 1)

old = """        case 'phone-not-playing':
          calibration.fail('Play YouTube on the phone before calibration.');
          return;
      }
      return;
    }

    if (calibrationAction.startCalibrationMode === 'boot-probe') {
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
new = """        case 'phone-not-playing':
          calibration.fail('Play YouTube on the phone before calibration.');
          return;
        case 'content-mapping-pending':
          sendJson(socket, {
            type: 'calibration-command-rejected',
            reason: 'content-mapping-pending',
          });
          return;
      }
      return;
    }

    if (calibrationAction.startCalibrationMode === 'boot-probe') {
      restartManualBootCalibration(nowMs);
      return;
    }

    cancelActiveContentValidation(nowMs);"""
if old not in text:
    raise SystemExit('server manual gate replacement anchor not found')
path.write_text(text.replace(old, new, 1))
