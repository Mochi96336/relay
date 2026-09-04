from pathlib import Path

path = Path("src/server.ts")
text = path.read_text()

old = """function robotContentMappingReady(nowMs = performance.now()) {
  if (!robotProbeTimingActive()) return true;
  return sourceRuntime.connected()
    && robotContentTimeline.isReady(calibrationContext(), nowMs);
}

function mappedContentBackingStart(startSample: number, nowMs = performance.now()) {"""
new = """function robotContentMappingReady(nowMs = performance.now()) {
  if (!robotProbeTimingActive()) return true;
  return sourceRuntime.connected()
    && robotContentTimeline.isReady(calibrationContext(), nowMs);
}

// A fresh timeline can still be intentionally withholding backing PCM while a
// follower correction waits for its capture/content boundary. That mapping is
// safe for the already-applied live authority (which keeps using committed
// content), but it is not usable as new correlation evidence: mapBackingStart()
// will return null until the boundary is committed.
function robotContentEvidenceMappingReady(nowMs = performance.now()) {
  if (!robotContentMappingReady(nowMs)) return false;
  return !robotContentTimeline.needsBackingBoundary(calibrationContext());
}

function mappedContentBackingStart(startSample: number, nowMs = performance.now()) {"""
if old not in text:
    raise SystemExit("mapping helper insertion anchor not found")
text = text.replace(old, new, 1)

old = """    || probeCalibrationExhausted(nowMs)
    || !robotContentMappingReady(nowMs)
  ) return false;"""
new = """    || probeCalibrationExhausted(nowMs)
    || !robotContentEvidenceMappingReady(nowMs)
  ) return false;"""
if old not in text:
    raise SystemExit("priming gate anchor not found")
text = text.replace(old, new, 1)

old = "if (robotProbeTimingActive() && !robotContentMappingReady(nowMs)) return;"
count = text.count(old)
if count != 2:
    raise SystemExit(f"expected 2 auto/validation mapping gates, found {count}")
text = text.replace(old, "if (robotProbeTimingActive() && !robotContentEvidenceMappingReady(nowMs)) return;")

old = """      console.warn(
        '[robot-content-transition] degraded fail-closed:'
        + ` reason=${status.degradedReason ?? 'unknown'}`
        + ` windows=${status.windowsStarted}/${status.maxWindows}`
        + ` workerFailures=${status.workerFailures}/${status.maxWorkerFailures}`
        + ` ageMs=${status.ageMs}`,
      );
      broadcastJson(timingCalibrationStatusPayload());"""
new = """      console.warn(
        '[robot-content-transition] degraded fail-closed:'
        + ` reason=${status.degradedReason ?? 'unknown'}`
        + ` windows=${status.windowsStarted}/${status.maxWindows}`
        + ` workerFailures=${status.workerFailures}/${status.maxWorkerFailures}`
        + ` ageMs=${status.ageMs}`,
      );
      // A verifying transition may temporarily pause an existing content
      // collection while its backing PCM is quarantined. Once the verifier
      // degrades, however, there is no commit that can ever release that PCM.
      // End the transaction immediately instead of leaving Mic evidence to
      // grow against 0 ms of usable backing until the calibration timeout.
      if (
        timingRuntime.calibrationKind === 'content'
        && calibration.collecting
      ) {
        calibration.fail(
          'Robot backing content mapping could not be verified. Wait for the Robot source mapping to recover before calibration.',
        );
      }
      broadcastJson(timingCalibrationStatusPayload());"""
if old not in text:
    raise SystemExit("degraded callback anchor not found")
text = text.replace(old, new, 1)

path.write_text(text)
